#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";

const manifestPath = process.argv[2];
// Loopback broker that holds each tools/call until Pi supplies its real result.
const brokerUrl = process.argv[3];
if (!manifestPath) process.exit(2);
const tools = JSON.parse(await readFile(manifestPath, "utf8"));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const calls = new Map();

const denied = {
  isError: true,
  content: [{ type: "text", text: "Denied: Claude Code tools are inert; only Pi executes tools." }],
};

function respond(id, result) {
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/** Forward a call to the broker. Uses node:http because fetch would time out a long-held call. */
function forward(request) {
  const body = Buffer.from(JSON.stringify(request.params ?? {}));
  let answered = false;
  const answer = (result) => {
    if (answered) return;
    answered = true;
    calls.delete(request.id);
    respond(request.id, result);
  };
  const call = httpRequest(brokerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": body.length },
  });
  // A cancelled call gets no response.
  calls.set(request.id, () => {
    answered = true;
    calls.delete(request.id);
    call.destroy();
  });
  call.once("response", (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.once("end", () => {
      try {
        answer(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : denied);
      } catch {
        answer(denied);
      }
    });
    response.once("error", () => answer(denied));
  });
  call.once("error", () => answer(denied));
  call.end(body);
}

for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-inert-tool-inventory", version: "1" },
    });
  } else if (request.method === "tools/list") {
    respond(request.id, { tools });
  } else if (request.method === "tools/call") {
    if (brokerUrl) forward(request);
    else respond(request.id, denied);
  } else if (request.method === "notifications/cancelled") {
    // Claude Code gave up on the call. Dropping it tells the broker that this
    // process can no longer continue with Pi's result.
    calls.get(request.params?.requestId)?.();
  } else {
    respond(request.id, {});
  }
}
process.exit(0);
