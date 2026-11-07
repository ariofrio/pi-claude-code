import * as http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/** MCP `tools/call` result content. */
export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
}

const TOOL_USE_ID_META = "claudecode/toolUseId";
const MAX_CALL_BODY_BYTES = 1_000_000;

/**
 * Loopback endpoint the inert MCP server forwards `tools/call` to. A call is
 * held until Pi supplies the real result for its tool use, so the same Claude
 * Code process continues with Pi's result instead of a placeholder.
 */
export class ToolBroker {
  /** Set when a held call was abandoned (Claude Code timed it out or exited). */
  broken = false;

  private readonly prefix = `/tools/${randomBytes(32).toString("base64url")}`;
  private readonly server: http.Server;
  private readonly held = new Map<string, (result: McpToolResult) => void>();
  private readonly results = new Map<string, McpToolResult>();
  private closed = false;

  constructor(private readonly onHeld: (toolUseId: string) => void) {
    this.server = http.createServer((request, response) => void this.handle(request, response));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${this.prefix}/call`;
  }

  /** True while Claude Code waits on at least one call. */
  get holding(): boolean {
    return this.held.size > 0;
  }

  /** Answer held calls, and calls Claude Code has yet to make, with Pi's results. */
  provide(results: Map<string, McpToolResult>): void {
    this.results.clear();
    for (const [id, result] of results) {
      const respond = this.held.get(id);
      if (respond) respond(result);
      else this.results.set(id, result);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== `${this.prefix}/call` || request.headers.origin || this.closed) {
      response.writeHead(404).end();
      return;
    }
    let params: { _meta?: Record<string, unknown> };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_CALL_BODY_BYTES) throw new Error("tool call too large");
        chunks.push(chunk as Buffer);
      }
      params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    const id = params._meta?.[TOOL_USE_ID_META];
    if (typeof id !== "string" || !id || this.held.has(id)) {
      this.broken = true;
      response.writeHead(400).end();
      return;
    }

    const send = (result: McpToolResult) => {
      this.held.delete(id);
      const body = Buffer.from(JSON.stringify(result));
      response.writeHead(200, { "content-type": "application/json", "content-length": body.length }).end(body);
    };
    const ready = this.results.get(id);
    if (ready) {
      this.results.delete(id);
      send(ready);
      return;
    }
    this.held.set(id, send);
    response.once("close", () => {
      if (this.held.get(id) !== send) return;
      this.held.delete(id);
      this.broken = true;
    });
    this.onHeld(id);
  }
}
