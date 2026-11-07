# Architecture

This document explains how pi-claude-code works internally. For installation
and usage, see [README.md](README.md).

## Overview

The extension registers a Pi provider that routes all Claude model
communication through the official Claude Code CLI. It talks to Claude Code
through Claude Code's native `stream-json` protocol and translates streamed
responses back into Pi's message format.

Pi remains responsible for conversation history, approvals, compaction, and tool
execution. The extension exposes Pi's tools to Claude Code through an inert MCP
inventory. Claude can request a tool, but Claude Code cannot execute it; the
request is returned to Pi instead. Claude Code's call to the inert server is
held open until Pi has run the tool, so the same Claude Code process can
continue with Pi's result.

## Authentication

Claude Code owns and stores its credentials. The extension does not read its
credential files, refresh its tokens, or persist them. Authenticated request
headers do pass transiently through the local turn relay described below.

The provider has an ambient API-key-style auth method without a login flow. Its
`check()` runs `claude auth status` and reports the provider as configured only
when Claude Code is installed and logged in, so Pi hides the models otherwise.
Requests resolve to a placeholder key. It reports Claude
subscription logins as OAuth-shaped auth so that Pi labels list-price accounting
as a subscription. The provider also declares an `oauth` method, marked
`isSubscription`, only so Pi's subscription-aware UI works. Its `login()` never
starts a flow; it tells the user to run `claude auth login`.

Claude Code child processes do not inherit `ANTHROPIC_API_KEY`. The parent
environment is unchanged. Inherited auth-token, proxy, Bedrock, Vertex, and
Foundry overrides are still rejected to avoid silently changing authentication
or billing.

## Usage-credit guard

Claude Code emits a `rate_limit_event` for each turn. If it reports
`isUsingOverage`, the response was charged to usage credits rather than plan
limits, and the turn fails with a non-retryable `Claude Code billing` error
unless `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` is set. Upstream rejections that
ask for usage credits (for example third-party app classification) are
rewritten into the same kind of error. The latest rate-limit status is attached
to the assistant message as a `claude-code.rate-limit` diagnostic.

## Process reuse

Linear conversations may reuse a warm Claude Code process, including across
tool calls. Only exact linear continuations reuse one:

- After a final answer, the next user message is written to the same process.
- After a tool-use response, Claude Code waits on its call to the inert MCP
  server. The server forwards the call to a random loopback route owned by the
  extension, which holds it. If Pi's next request has the same history and its
  last message carries exactly the results for those tool uses, the held calls
  are answered and Claude Code continues the same run; nothing is written to
  its stdin. Claude Code's copy of each result is a placeholder, and the relay
  sends Pi's result upstream in its place, so the request matches a full
  replay. Calls that Claude Code has not made yet (it calls parallel tools one
  at a time) are answered as soon as it makes them.

Everything else falls back to a fresh process, which replays Pi's full
conversation: branches, edits, compaction, configuration changes, errors, a
user message sent alongside tool results, image tool results (Claude Code
re-encodes images it receives through MCP differently from replayed ones),
tools Pi never declared, and a held call that Claude Code abandoned (for
example after a user-set `MCP_TOOL_TIMEOUT`). Workers disable Claude Code's
MCP auto-backgrounding and its in-loop "silent turn" reminder, which a
replayed history never contains.

At most two processes are retained, and no process is retained for more than
five minutes.

## Local turn relay

Each Claude Code worker receives an `ANTHROPIC_BASE_URL` that points to a
random, loopback-only HTTP route owned by this extension.

The relay exists because Pi, rather than Claude Code, owns the agent loop and
tool execution. In particular, it:

- forwards exactly one Anthropic Messages request for each Pi turn and rejects
  additional native recovery attempts. Claude Code can otherwise issue another
  generation after a failed tool call or a `max_tokens` stop, even with HTTP
  retries disabled. While Pi runs a tool, no turn is armed, so nothing reaches
  the upstream API until Pi's next turn answers the held call;
- captures and streams the first upstream response before Claude Code processes
  it, preserving signed thinking, tool arguments, usage, and the native stop
  reason. A tool-use turn ends once the response is complete and Claude Code
  waits on a held call, so Pi gets the tool request without waiting for Claude
  Code's own result. The usage-credit guard also reads the response's
  rate-limit headers, because Claude Code may report its `rate_limit_event`
  only after that point;
- rebuilds every user message from Pi's own history. Claude Code adds
  reminders to user messages and tool results (auto-memory, CLAUDE.md, the
  account email, attachments). The relay matches Pi's blocks to Claude Code's
  in order and drops the rest. It keeps Claude Code's copies of images, because
  it may have downscaled them and added a note on how to map coordinates back
  to the original. Workers also disable auto-memory and CLAUDE.md loading, so
  those reminders are not created in the first place. If a request no longer
  lines up with Pi's history, the turn fails rather than sending a guess;
- records Claude Code's initial native system messages (environment, date),
  then restores their stable layout during full-history replay. It also adjusts
  cache breakpoints so tool rounds do not continually invalidate the
  prompt-cache prefix;
- injects supported mid-conversation tool additions and removals at their
  original assistant boundaries and adds the corresponding Anthropic beta
  header; and
- ties cancellation to the active upstream socket as well as the Claude Code
  process.

## Tool schemas

Tool schemas are normalized for Claude Code. Nullable variants and schema
composition such as `oneOf`, `allOf`, and `anyOf` may be simplified or removed.

Exact mid-conversation tool additions and removals, including prompt-cache
preservation, work only on supported models. Other cases fall back to the
current tool state and may lose prompt-cache reuse.
