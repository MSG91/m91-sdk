# Changelog

## 1.2.0

### Added
- **OpenAI Agents SDK** (`@msg91comm/m91/integrations/openai-agents`): `runWithM91Approvals` answers every `needsApproval` interruption on a phone and resumes the run; `approveInterruptionsWithM91` for your own loop; `createM91Tools`.
- **Claude Agent SDK** (`@msg91comm/m91/integrations/claude-agent-sdk`): `createM91CanUseTool` (a `canUseTool` callback), `createM91PreToolUseHook` (gates in every permission mode), and `createM91McpServer` (the two tools as an in-process MCP server).
- **Google ADK for TypeScript** (`@msg91comm/m91/integrations/google-adk`): `createM91BeforeToolCallback` gates named tools; `createM91Tools` as `FunctionTool`s.
- **Mastra** (`@msg91comm/m91/integrations/mastra`): `generateWithM91Approvals` answers `requireApproval` suspensions; `createM91Tools`.
- **Vercel AI SDK**: `createM91ToolApproval`, a `toolApproval` function that rings a phone before the tools you name run.
- **LangChain `humanInTheLoopMiddleware` and Deep Agents** (`@msg91comm/m91/integrations/langchain`): `invokeWithM91Approvals` answers each `interruptOn` pause on a phone and resumes with `Command({ resume: { decisions } })`; `resolveHITLWithM91` builds the decisions for your own loop.
- `decideToolCall`, `GateOptions`: the shared fail-closed gate every adapter above uses.

### Fixed
- Vercel AI SDK tool factories return `Tool` / `ToolSet`, and LangChain's return `DynamicStructuredTool`, instead of `unknown`, so they type-check in `generateText({ tools })` and `createAgent({ tools })`. Runtime behaviour is unchanged.
- The `ai` peer range is `>=5.0.0`, matching the `inputSchema` tool format.
- Docs and docstrings use the published package name (`@msg91comm/m91`) and current APIs (`createAgent`, `isStepCount`).

## Fixed
- `@msg91comm/m91/integrations/vercel-ai`: `createM91ApprovalTool`, `createM91AlertTool` and `createM91Tools` are now typed as the AI SDK's `Tool` / `ToolSet` instead of `unknown`, so they type-check inside `generateText({ tools })`. Runtime behaviour is unchanged.
- The `ai` peer dependency range is now `>=5.0.0`, matching the `inputSchema` tool format these factories use.

## 1.1.1

Metadata only — no code change.

`homepage` pointed at `https://m91.msg91.com`, which does not resolve: that
host is the static site, and every backend route lives on `m91-api.msg91.com`.
npm renders `homepage` as a link on the package page and freezes it per
version, so 1.1.0's link is dead for the life of that version. It now points at
the documentation.

The package also went out as `@msg91comm/m91` while the repository still said
`"name": "m91"`, so the next publish would have gone to a different package.
The repository now matches what is published.


## 1.1.0

Three gaps where the server had grown a field and the SDK had not, so the only
route to a value you had explicitly asked for was the raw body.

**Nothing breaks.** `AlertDetail.responses` holds typed objects now, and they
still answer to `r["label"]` and `r.get("note")` — the spelling callers already
use — so upgrading changes nothing you have written. (Python; in Node they were
`unknown[]`, which required a cast either way.)

### Added

- `send({ attachments: [...] })` — https links to files the alert is about. URLs,
  never bytes, because every automation a send link is pasted into has a URL
  field and little else. Validated locally so a typo costs no round trip.
- `send({ callbackUrl: ... })` — where the outcome is POSTed when somebody answers.
- `Response.note` and `Response.attachments`, the two things a sender can
  require before an option may be chosen.
- `AlertDetail.attachments` and `AlertDetail.pending`.
- `Attachment` and `Response` types.
- `M91Platform.listChannels()` — the
  missing half of the non-idempotent `create_channel`. A platform that lost the
  response to a create had an orphaned channel and no way to find it.


## 1.0.0

First release.

- `M91Client` — verify, send, getAlert, waitForDecision, close, requestApproval,
  against a channel send link.
- `M91Platform` — verify the key, invite and alert one person by phone number,
  and provision team channels, with an API key.
- `M91URLBuilder` — the GET form, for anything whose only field is "URL to call".
- Integrations: LangChain, LangGraph and the Vercel AI SDK.

Zero runtime dependencies: native `fetch`, Node 18+. Every framework adapter
imports its framework lazily, so installing this package pulls in none of them.

Four behaviours worth calling out, because they are the ones that differ from
what a hand-rolled wrapper around `fetch` usually does:

- **A send that reaches nobody throws `M91DeliveryError`.** `delivered` counts
  phones actually sent to, not the size of the roster, so a channel whose device
  tokens are all stale answers 201 and wakes nobody. This applies to
  `alertPerson` as well as `send`, and matters more there: a direct alert has a
  roster of one. Pass `{ throwOnZeroDelivery: false }` to opt out.
- **`close()` treats 404 and 403 as success.** Nothing left to close is the
  state the caller asked for.
- **`waitForDecision()` reads `decision` only.** A PERSONAL response ("Seen")
  never ends the wait, because "Seen" must never read as "Approved".
- **`verify()` on both clients tests a credential without waking anybody.**
  `M91Client.verify()` pings the send link; `M91Platform.verify()` calls
  `GET /api/v1/me` and names the key and its owner.
- **The send token is redacted from every string the SDK produces** — `toString`,
  error messages and tool results — including text written by the runtime, which
  can name the URL a request failed on.
