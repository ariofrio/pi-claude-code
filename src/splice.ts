import { createHash } from "node:crypto";
import type { NativeFrame } from "./native-types.ts";
import type { NativeSystemInjection } from "./transcript.ts";

/**
 * Splice mode: keep Claude Code's request envelope (headers, system prompt
 * prefix, metadata, model settings) and replace its message list with Pi's own
 * history. Claude Code's rewrites of the conversation (reminders, image
 * removal, flattened error results) never reach the API, so nothing has to be
 * reconciled. The rules Claude Code would otherwise enforce for us are applied
 * here from the Messages API's documented constraints.
 */

type Block = Record<string, unknown>;
interface WireMessage {
  role?: string;
  content?: unknown;
}

const EPHEMERAL = { type: "ephemeral", ttl: "1h" } as const;
const MEDIA_REMOVED = "[media removed: request limit]";
/** Same caps Claude Code 2.1.316 applies (count 100, trimmed to 80; 75 MiB of base64, trimmed by 10 MiB more). */
export const MEDIA_LIMITS = { maxCount: 100, trimTo: 80, maxBytes: 75 * 1024 * 1024, trimBytes: 10 * 1024 * 1024 };
const MAX_CACHE_BREAKPOINTS = 4;

const isBlock = (value: unknown): value is Block => !!value && typeof value === "object" && !Array.isArray(value);

function stripCacheControl(value: unknown): void {
  if (Array.isArray(value)) value.forEach(stripCacheControl);
  else if (isBlock(value)) {
    delete value.cache_control;
    for (const child of Object.values(value)) if (typeof child === "object") stripCacheControl(child);
  }
}

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, child) => sum + countCacheControl(child), 0);
  if (!isBlock(value)) return 0;
  let count = value.cache_control ? 1 : 0;
  for (const [key, child] of Object.entries(value)) if (key !== "cache_control") count += countCacheControl(child);
  return count;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Block => isBlock(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Error tool results must be text only and non-empty; text blocks must be non-blank. */
function normalizeContent(blocks: unknown[]): unknown[] {
  const output: unknown[] = [];
  for (const block of blocks) {
    if (!isBlock(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) continue;
    if (block.type === "tool_result") {
      let content = block.content;
      if (block.is_error) {
        content = textOf(content) || "(tool failed without text output)";
      } else if (Array.isArray(content)) {
        content = normalizeContent(content);
        if ((content as unknown[]).length === 0) content = "(no output)";
      } else if (typeof content === "string" && !content) {
        content = "(no output)";
      }
      output.push({ ...block, content });
      continue;
    }
    output.push(block);
  }
  return output;
}

interface MediaRef {
  container: unknown[];
  block: Block;
  bytes: number;
  inToolResult: boolean;
}

function collectMedia(messages: WireMessage[]): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isBlock(block)) continue;
      if (block.type === "image" || block.type === "document") {
        refs.push({ container: message.content, block, bytes: mediaBytes(block), inToolResult: false });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (isBlock(inner) && (inner.type === "image" || inner.type === "document")) {
            refs.push({ container: block.content, block: inner, bytes: mediaBytes(inner), inToolResult: true });
          }
        }
      }
    }
  }
  return refs;
}

function mediaBytes(block: Block): number {
  const source = block.source;
  return isBlock(source) && typeof source.data === "string" ? source.data.length : 0;
}

/** Drop the oldest images once the request exceeds the media count or size Claude Code would allow. */
export function enforceMediaLimits(messages: WireMessage[], limits = MEDIA_LIMITS): number {
  const refs = collectMedia(messages);
  const removed = new Set<MediaRef>();
  let total = refs.reduce((sum, ref) => sum + ref.bytes, 0);
  if (refs.length > limits.maxCount) {
    for (const ref of refs.slice(0, refs.length - limits.trimTo)) {
      removed.add(ref);
      total -= ref.bytes;
    }
  }
  if (total > limits.maxBytes) {
    for (const ref of refs) {
      if (total <= limits.maxBytes - limits.trimBytes) break;
      if (removed.has(ref)) continue;
      removed.add(ref);
      total -= ref.bytes;
    }
  }
  for (const ref of removed) {
    const index = ref.container.indexOf(ref.block);
    if (index >= 0) ref.container.splice(index, 1, { type: "text", text: MEDIA_REMOVED });
  }
  return removed.size;
}

function setBreakpoint(message: WireMessage | undefined): void {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content.at(-1);
  if (isBlock(last)) last.cache_control = { ...EPHEMERAL };
}

/** cc_version suffix: Claude Code's attribution fingerprint of the first user message. */
export function attributionFingerprint(firstUserText: string, version: string): string {
  const chars = [4, 7, 20].map((index) => firstUserText[index] || "0").join("");
  return createHash("sha256").update(`59cf53e54c78${chars}${version}`).digest("hex").slice(0, 3);
}

function fixBillingHeader(system: unknown, firstUserText: string): void {
  if (!Array.isArray(system)) return;
  const first = system[0];
  if (!isBlock(first) || typeof first.text !== "string") return;
  first.text = first.text.replace(
    /(cc_version=)(\d+\.\d+\.\d+)\.([0-9a-f]{3});/u,
    (_, prefix: string, version: string) => `${prefix}${version}.${attributionFingerprint(firstUserText, version)};`,
  );
}

/** Every tool_use needs a tool_result at the start of the next user message; answer interrupted ones. */
export function answerOrphanedToolCalls(messages: WireMessage[]): number {
  let added = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const ids = message.content.filter((b): b is Block => isBlock(b) && b.type === "tool_use").map((b) => b.id as string);
    if (!ids.length) continue;
    let next = messages[index + 1];
    if (next?.role !== "user") {
      next = { role: "user", content: [] };
      messages.splice(index + 1, 0, next);
    }
    if (!Array.isArray(next.content)) next.content = typeof next.content === "string" ? [{ type: "text", text: next.content }] : [];
    const content = next.content as unknown[];
    const answered = new Set(
      content.filter((b): b is Block => isBlock(b) && b.type === "tool_result").map((b) => b.tool_use_id as string),
    );
    const missing = ids.filter((id) => !answered.has(id));
    content.unshift(
      ...missing.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(tool call was interrupted)", is_error: true })),
    );
    // tool_results must come before any other content in the message.
    content.sort((a, b) => Number(isBlock(b) && b.type === "tool_result") - Number(isBlock(a) && a.type === "tool_result"));
    added += missing.length;
  }
  return added;
}

export function spliceRequest(
  body: Buffer,
  frames: NativeFrame[],
  initialSystemMessages: unknown[] | undefined,
  nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
  const payload = JSON.parse(body.toString("utf8")) as { messages?: WireMessage[]; system?: unknown; tools?: unknown };

  let messages: WireMessage[] = frames.map((frame) => ({
    role: frame.message.role,
    content: normalizeContent(structuredClone(frame.message.content)),
  }));
  for (const message of messages) stripCacheControl(message.content);

  // Claude Code's Environment message, after the first user message, as it sends it.
  const environment = initialSystemMessages?.length ? (structuredClone(initialSystemMessages) as WireMessage[]) : [];
  if (!environment.length && payload.messages?.[0]?.role === "user") {
    for (const message of payload.messages.slice(1)) {
      if (message.role !== "system") break;
      environment.push(structuredClone(message));
    }
  }
  if (environment.length) {
    stripCacheControl(environment);
    messages.splice(1, 0, ...environment);
  }

  if (nativeSystemInjections?.length) {
    const byAssistant = new Map<number, WireMessage[]>();
    const trailing: WireMessage[] = [];
    for (const injection of nativeSystemInjections) {
      const message = { role: "system", content: structuredClone(injection.content) };
      if (injection.beforeAssistant === null) trailing.push(message);
      else byAssistant.set(injection.beforeAssistant, [...(byAssistant.get(injection.beforeAssistant) ?? []), message]);
    }
    const output: WireMessage[] = [];
    let ordinal = 0;
    for (const message of messages) {
      if (message.role === "assistant") output.push(...(byAssistant.get(ordinal++) ?? []));
      output.push(message);
    }
    messages = [...output, ...trailing];
  }

  answerOrphanedToolCalls(messages);
  enforceMediaLimits(messages);

  // Pi's turn boundaries: the previous queried user message and the final one.
  const userIndexes = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const budget = MAX_CACHE_BREAKPOINTS - countCacheControl(payload.system) - countCacheControl(payload.tools);
  if (budget >= 2 && userIndexes.length >= 2) setBreakpoint(messages[userIndexes.at(-2)!]);
  if (budget >= 1) setBreakpoint(messages.at(-1));

  payload.messages = messages;
  const firstText = frames[0]?.message.content.find((block) => isBlock(block) && block.type === "text") as Block | undefined;
  fixBillingHeader(payload.system, typeof firstText?.text === "string" ? firstText.text : "");
  return Buffer.from(JSON.stringify(payload));
}

export function spliceEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.PI_CLAUDE_CODE_SPLICE?.trim().toLowerCase();
  return !!value && !["0", "false", "no", "off"].includes(value);
}
