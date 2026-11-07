import assert from "node:assert/strict";
import * as http from "node:http";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeClaudeProcesses, runClaudeRequest, type RunClaudeInput } from "../src/claude-cli.ts";
import type { NativeFrame } from "../src/native-types.ts";

/**
 * A Claude Code stand-in that, like the real one, sends each generation through
 * ANTHROPIC_BASE_URL, calls the MCP server for every tool use, waits for its
 * answer, and then sends the next generation from its own in-memory history.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(0);
}
appendFileSync(process.env.PROCESS_LOG, process.pid + "\n");
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--allowedTools") || arg("--allowedTools") !== "mcp__pi") throw new Error("MCP tools not allowed");
if (process.argv.includes("--max-turns")) throw new Error("max turns would end the turn at a tool call");
const server = JSON.parse(arg("--mcp-config")).mcpServers.pi;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message.result);
  pending.delete(message.id);
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
await rpc("initialize", {});

function parseSse(text) {
  const message = { role: "assistant", content: [] };
  const args = new Map();
  for (const frame of text.split("\n\n")) {
    const data = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!data) continue;
    const event = JSON.parse(data.slice(5));
    if (event.type === "content_block_start") message.content[event.index] = event.content_block;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") message.content[event.index].text += event.delta.text;
    if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") args.set(event.index, (args.get(event.index) ?? "") + event.delta.partial_json);
    if (event.type === "content_block_stop" && args.has(event.index)) message.content[event.index].input = JSON.parse(args.get(event.index));
  }
  return message;
}

const history = [];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  appendFileSync(process.env.FRAME_LOG, JSON.stringify(frame.message.content) + "\n");
  history.push(frame.message);
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0, user_message_uuids: [frame.uuid] }));
    continue;
  }
  if (frame.type !== "user") continue;
  for (;;) {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: history }),
    }).catch(() => undefined);
    if (!response || response.status !== 200) {
      console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, user_message_uuids: [frame.uuid] }));
      break;
    }
    const assistant = parseSse(await response.text());
    history.push(assistant);
    const calls = assistant.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) {
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, user_message_uuids: [frame.uuid] }));
      break;
    }
    const results = [];
    for (const call of calls) {
      const name = call.name.slice("mcp__pi__".length);
      const reply = rpc("tools/call", { name, arguments: call.input, _meta: { "claudecode/toolUseId": call.id } });
      if (process.env.CANCEL_CALL) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: nextId - 1 } }) + "\n");
      }
      const result = await reply;
      appendFileSync(process.env.CALL_LOG, JSON.stringify({ id: call.id, result }) + "\n");
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError });
    }
    history.push({ role: "user", content: results });
  }
}
`;

interface Upstream {
  url: string;
  bodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  close(): Promise<void>;
}

/** Anthropic stand-in: answers queries naming "call-tool" (and tool results for t1) with tool uses. */
async function fakeUpstream(limitStatus = "allowed"): Promise<Upstream> {
  const bodies: Upstream["bodies"] = [];
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as Upstream["bodies"][number];
    bodies.push(body);
    const last = body.messages.at(-1)!.content as Array<Record<string, unknown>>;
    const usage = { input_tokens: 2, output_tokens: 1 };
    const blocks: Array<Record<string, unknown>> = [];
    let stop = "end_turn";
    if (last.some((block) => block.type === "text" && block.text === "call-tool")) {
      blocks.push({ type: "tool_use", id: "t1", name: "mcp__pi__echo", input: { value: "a" } });
      blocks.push({ type: "tool_use", id: "t2", name: "mcp__pi__echo", input: { value: "b" } });
      stop = "tool_use";
    } else if (last.some((block) => block.type === "tool_result" && block.tool_use_id === "t1")) {
      blocks.push({ type: "tool_use", id: "t3", name: "mcp__pi__echo", input: { value: "c" } });
      stop = "tool_use";
    } else {
      blocks.push({ type: "text", text: `reply ${bodies.length}` });
    }
    const events: unknown[] = [{ type: "message_start", message: { id: `m${bodies.length}`, role: "assistant", content: [], usage } }];
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else {
        events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: stop }, usage });
    events.push({ type: "message_stop" });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "anthropic-ratelimit-unified-status": limitStatus,
      "anthropic-ratelimit-unified-overage-status": "allowed",
    });
    for (const event of events) response.write(`event: x\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const user = (text: string): NativeFrame => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const replayed = (frame: NativeFrame): NativeFrame => ({ ...frame, shouldQuery: false });
const assistant = (content: unknown[]): NativeFrame => ({ type: "assistant", message: { role: "assistant", content } });
const toolResults = (...results: Array<[string, string]>): NativeFrame => ({
  type: "user",
  message: {
    role: "user",
    content: results.map(([id, content]) => ({ type: "tool_result", tool_use_id: id, content, is_error: false })),
  },
});

async function harness(t: test.TestContext, env: Record<string, string> = {}, limitStatus?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-hold-")));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  const upstream = await fakeUpstream(limitStatus);
  t.after(async () => {
    await closeClaudeProcesses();
    await upstream.close();
    await rm(root, { recursive: true, force: true });
  });
  const logs = { processes: join(root, "processes.log"), frames: join(root, "frames.log"), calls: join(root, "calls.log") };
  for (const path of Object.values(logs)) await writeFile(path, "", "utf8");
  const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const base: Omit<RunClaudeInput, "frames"> = {
    model: "sonnet",
    cwd: root,
    systemPrompt: "system",
    manifest: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
    extraBody: {},
    env: {
      PI_CLAUDE_CODE_COMMAND: executable,
      PROCESS_LOG: logs.processes,
      FRAME_LOG: logs.frames,
      CALL_LOG: logs.calls,
      ...env,
    },
    upstreamUrl: upstream.url,
    timeoutMs: 5_000,
    sessionId: `hold-${Math.random()}`,
  };
  const run = (frames: NativeFrame[]) => runClaudeRequest({ ...base, frames });
  return { run, upstream, processes: () => lines(logs.processes), frames: () => lines(logs.frames), calls: () => lines(logs.calls) };
}

test("continues the same Claude Code process with Pi's tool results instead of replaying history", async (t) => {
  const { run, upstream, processes, frames, calls } = await harness(t);

  const first = await run([user("call-tool")]);
  assert.equal(first.message.stop_reason, "tool_use");
  assert.deepEqual(
    first.message.content.map((block) => (block as { id?: string }).id),
    ["t1", "t2"],
  );

  // Pi executes both tools and appends their results.
  const history = [replayed(user("call-tool")), assistant(first.message.content)];
  const second = await run([...history, toolResults(["t1", "result a"], ["t2", "result b"])]);
  assert.equal(second.message.stop_reason, "tool_use");
  assert.equal(second.relay.upstreamRequests, 1);
  assert.equal(second.relay.blockedRequests, 0);

  // Same process, and nothing was written to it after the first user frame:
  // the tool results reached Claude Code through its held MCP calls.
  assert.equal((await processes()).length, 1);
  assert.equal((await frames()).length, 1);
  assert.deepEqual(
    (await calls()).map((line) => (JSON.parse(line) as { id: string }).id),
    ["t1", "t2"],
  );
  // Claude Code's copy is a placeholder; the request carries Pi's canonical results.
  assert.deepEqual(upstream.bodies[1]!.messages.at(-1)!.content, [
    { type: "tool_result", tool_use_id: "t1", content: "result a", is_error: false },
    { type: "tool_result", tool_use_id: "t2", content: "result b", is_error: false },
  ]);

  // A second tool round continues the same process again, then the final answer
  // leaves it ready for the next user message.
  const third = await run([
    ...history,
    toolResults(["t1", "result a"], ["t2", "result b"]),
    assistant(second.message.content),
    toolResults(["t3", "result c"]),
  ]);
  assert.deepEqual(third.message.content, [{ type: "text", text: "reply 3" }]);
  assert.equal((await processes()).length, 1);
  assert.equal((await frames()).length, 1);
});

test("replays history in a fresh process when Pi's next turn does not answer exactly the held calls", async (t) => {
  const { run, processes, frames } = await harness(t);
  const first = await run([user("call-tool")]);
  const history = [replayed(user("call-tool")), assistant(first.message.content)];

  // A steering message merged into the tool-result turn cannot go through MCP.
  const results = toolResults(["t1", "result a"], ["t2", "result b"]);
  results.message.content.push({ type: "text", text: "and then stop" });
  const second = await run([...history, results]);
  assert.equal(second.relay.upstreamRequests, 1);
  assert.equal((await processes()).length, 2);
  assert.equal((await frames()).length, 1 + history.length + 1);
});

test("replays history for an image tool result so Claude Code can downscale it as on replay", async (t) => {
  const { run, processes } = await harness(t);
  const first = await run([user("call-tool")]);
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const results = toolResults(["t1", "a"], ["t2", "b"]);
  (results.message.content[1] as Record<string, unknown>).content = [{ type: "text", text: "b" }, image];
  await run([replayed(user("call-tool")), assistant(first.message.content), results]);
  assert.equal((await processes()).length, 2);
});

test("replays history in a fresh process after Claude Code abandons a held call", async (t) => {
  const { run, processes } = await harness(t, { CANCEL_CALL: "1" });
  const first = await run([user("call-tool")]);
  assert.equal(first.message.stop_reason, "tool_use");
  // Give Claude Code's cancellation time to reach the broker.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await run([replayed(user("call-tool")), assistant(first.message.content), toolResults(["t1", "a"], ["t2", "b"])]);
  assert.equal((await processes()).length, 2);
});

test("applies the usage-credit guard to a turn that ends at a held tool call", async (t) => {
  const { run } = await harness(t, {}, "rejected");
  await assert.rejects(run([user("call-tool")]), /Claude Code billing/);
});
