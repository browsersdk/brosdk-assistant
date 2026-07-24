# Brosdk Assistant Architecture Plan

This document describes the current architecture, the target architecture, and
the engineering rules for the next implementation phase. Product priorities and
release milestones live in [roadmap.md](roadmap.md).

## Product Boundary

Brosdk Assistant is a local-first Chrome side-panel assistant.

The default experience must work with only:

- the Chrome extension,
- the native messaging host, and
- a user-configured model API.

MCP servers and filesystem workspaces are optional capability sources. The
product does not depend on BrowserOS APIs and does not attempt to reproduce the
BrowserOS product.

## Product Contract

The primary workflow is:

1. Install the extension and native host.
2. Configure a supported model endpoint.
3. Ask about the current page without starting another browser service.
4. Switch to Agent Mode only when browser or workspace mutations are needed.
5. Attach tabs for an explicit multi-tab task.
6. Select a workspace only when local file access is useful.

The UI and documentation must not advertise an API provider, tool, mode, or
control before its execution path works end to end.

## Current Architecture

```text
Chrome side panel (React)
  -> extension background service worker
  -> chrome.runtime.connectNative("com.browsersdk.assistant")
  -> Rust native host
       -> model API
       -> optional MCP server
       -> scoped workspace tools
       -> extension browser-tool round trips
```

### Extension responsibilities

- Render the side-panel conversation and options page.
- Own Chrome tabs, side-panel, storage, and scripting APIs.
- Maintain the Native Messaging port in the background service worker.
- Execute built-in `browser_*` tools when Chrome Extension mode is selected.
- Store UI-only state such as recent workspace shortcuts.
- Never persist model credentials or agent configuration in extension storage.

### Native-host responsibilities

- Persist and validate settings.
- Call supported model APIs.
- Discover and invoke tools from a generic MCP server.
- Convert MCP schemas to provider-compatible tool definitions.
- Enforce Chat Mode and workspace boundaries.
- Execute scoped workspace tools.
- Coordinate agent runs and browser-tool requests.

### Settings ownership

The native host is the single source of truth for configuration.

- Windows: `%APPDATA%\BrosdkAssistant\settings.json`
- Other platforms: `$HOME/BrosdkAssistant/settings.json`

The extension may store recent-folder shortcuts, but not API keys, model
settings, MCP settings, side-panel behavior, or the selected workspace.

## Browser Tool Sources

### Chrome Extension

This is the default for new installations. It requires no CDP connection or
external MCP process.

Current tools:

- `browser_tabs`
- `browser_active_tab`
- `browser_read_page`
- `browser_snapshot`
- `browser_extract_links`
- `browser_navigate`
- `browser_click`
- `browser_type`

Known limitations:

- protected Chrome pages cannot be scripted,
- frames and shadow roots are not fully represented,
- snapshot refs expire after a newer snapshot, navigation, or target identity
  change and must be refreshed,
- click remains a best-effort DOM operation,
- screenshot, upload, download, select, scroll, keyboard, and wait tools are not
  implemented yet.

### MCP Server

MCP is an optional advanced mode. The native host must remain server-agnostic:

- initialize a Streamable HTTP session,
- discover tools with `tools/list`,
- invoke tools with `tools/call`,
- map provider-safe tool names back to original MCP names,
- use MCP tool metadata when enforcing read-only behavior.

Changing an MCP server must not require changes to the native host unless the
server violates or extends the MCP protocol.

Chat Mode applies a capability policy after discovery:

- known browser tools use the native host's conservative read-only allowlist and
  argument guards,
- unknown tools require standard `annotations.readOnlyHint=true`,
- a contradictory `annotations.destructiveHint=true` causes denial,
- missing annotations default to denial in Chat Mode but do not remove tools
  from Agent Mode.

### Off

No browser tools are exposed. Model chat and an explicitly selected workspace
remain available.

## Target Interaction Modes

| Capability | Chat Mode | Agent Mode |
| --- | --- | --- |
| Read current or attached pages | Yes | Yes |
| Read/search workspace | Yes | Yes |
| Navigate, click, or type | No | Yes |
| Write or edit workspace files | No | Yes |
| Unknown MCP tools | Deny unless read-only | Allowed by policy |
| Sensitive action confirmation | Not applicable | Required before execution |

The native host enforces these rules. Hiding a tool in the UI is not a security
boundary.

## Workspace Model

- `workspace_dir = "."` resolves to the isolated native default workspace.
- `workspace_dir = ""` means no workspace and exposes no workspace tools.
- Any other value must resolve to an existing directory selected by the user.
- Tool paths are relative to the selected workspace.
- Absolute paths, parent traversal, and symlink escapes are rejected.

Chat Mode exposes:

- `workspace_ls`
- `workspace_read_file`
- `workspace_search`

Agent Mode additionally exposes:

- `workspace_write_file`
- `workspace_edit_file`

## Conversation and Run Protocol

### Current run protocol

Starting a run returns a `run_id` immediately:

```json
{
  "id": "request-1",
  "result": {
    "run_id": "run-1",
    "conversation_id": "conversation-1",
    "state": "queued"
  }
}
```

The host then emits bounded events:

- `agent.status`
- `agent.delta`
- `agent.tool.started`
- `agent.tool.finished`
- `agent.done`
- `agent.error`
- `agent.cancelled`

`agent.done` is intentionally compact. It returns the final answer, capability
counts, and `details_available`, but does not repeat the full system prompt,
model messages, tool schemas, or tool results. The side panel requests those
details only when the user opens the answer's detail panel:

```json
{
  "id": "details-1",
  "method": "agent.run_details",
  "params": {
    "run_id": "run-1",
    "client_id": "side-panel-1"
  }
}
```

Completed details are memory-only, bound to the originating `client_id`, and
bounded by entry count and a Native Messaging-safe serialized size. Old details
may be evicted; oversized details retain prompt metadata and explicit omission
counts.

`agent.cancel` takes a `run_id`. The host must continue routing health,
settings, and tool responses while a run is active. No request may be consumed
and discarded while waiting for another response.

Implemented behavior:

- the stdout writer serializes all responses and events,
- the main input loop remains available while runs execute on worker threads,
- extension-tool responses are correlated through per-call waiters,
- cancellation is acknowledged immediately and suppresses late run events,
- async model requests select between network progress and cancellation, so
  pending response-header, response-body, and non-SSE reads are dropped without
  waiting for the request timeout,
- OpenAI-compatible SSE content is forwarded through `agent.delta`,
- SSE lines are reconstructed across arbitrary HTTP chunk boundaries with a
  bounded per-line buffer,
- streamed tool-call ids, names, and arguments are reconstructed by index,
- tool failures are returned to the model when recovery is possible,
- each side-panel instance supplies a `client_id` so broadcast run events do
  not leak into another panel's UI state,
- the native host owns bounded conversation context for asynchronous runs and
  exposes `conversation.get` and `conversation.reset`,
- `agent.run` remains as a blocking compatibility entrypoint.

The v0.2.0 reliability gate is complete. The next browser work belongs to the
v0.3.0 trustworthy-agent milestone: stable element references, richer actions,
confirmation policy, and broader browser task coverage.

Native Messaging output is limited to 1 MB per message. Large model output,
debug traces, page data, and tool results must be chunked or fetched separately
by identifier.

## Conversation Context

- A conversation has a stable identifier.
- `agent.start` loads prior completed user and assistant turns from the native
  host instead of trusting history supplied by the side panel.
- Only successful completed turns are committed; failed and cancelled runs do
  not enter later context.
- Context is bounded by message count and serialized size before provider calls.
- The host retains at most 50 in-memory conversations, 24 messages per
  conversation, and 64 KB of serialized context.
- New Chat calls `conversation.reset` before continuing with a new identifier.
- Tool-call traces and conversation persistence across native-host restarts are
  future work.
- Provider-specific token accounting will replace simple size limits later.

## Provider Policy

Only providers with a complete request, tool-call, error, and test path may be
selectable.

Current state:

- OpenAI-compatible Chat Completions: supported.
- Anthropic Messages API: planned, not yet selectable.

Provider adapters should eventually share these operations:

- validate configuration,
- prepare tool schemas,
- create a model request,
- normalize assistant text and tool calls,
- append tool results,
- report usage and provider errors.

## Trust and Safety Requirements

- Treat page text, MCP output, and workspace content as untrusted input.
- Chat Mode must default-deny tools that are not known to be read-only.
- Agent Mode must require confirmation for sensitive navigation, submission,
  download, upload, credential, and filesystem mutation actions.
- Tool errors should be returned to the model as tool errors when recovery is
  possible; one failed tool should not automatically destroy the whole run.
- API keys must not appear in logs, debug payloads, or model prompts.
- Debug details should be fetched by run id instead of duplicating all data in
  every assistant response.

## Target Native-host Modules

The native host is being split along ownership boundaries:

```text
src/
  main.rs
  protocol.rs
  settings.rs
  providers/
    mod.rs
    openai.rs
    anthropic.rs
  agent/
    mod.rs
    run.rs
    policy.rs
  tools/
    mod.rs
    mcp.rs
    extension.rs
    workspace.rs
```

Current progress:

- `tools/mcp.rs` owns generic Streamable HTTP session setup, notifications,
  tool discovery and invocation, JSON/SSE responses, session headers, and
  transport errors. Local HTTP integration tests cover its full lifecycle.
- `tools/workspace.rs` owns workspace schemas, read/write/search execution,
  path and symlink containment, and workspace security tests.
- `agent/run.rs` owns run and conversation registries, run lifecycle events,
  cancellation/reset handling, bounded host-owned context, and coordination
  tests.
- `protocol.rs` owns Native Messaging request and response types, bounded
  length-prefixed framing, serialized stdout writes, extension response
  correlation, and protocol-specific tests.
- `providers/openai.rs` owns OpenAI-compatible endpoint construction, blocking
  compatibility requests, cancellable streaming requests, SSE decoding, and
  provider-specific tests.
- `main.rs` owns the model/tool execution loop, MCP policy and provider mapping,
  extension-tool orchestration, and translates provider deltas into native
  events.
- `scripts/test_native_protocol_e2e.py` drives the compiled host through Native
  Messaging with a local mock model, including concurrent health routing,
  streamed deltas, extension tool correlation, and a two-round agent response.
- `extension/scripts/test-extension-smoke.mjs` loads a test-mode MV3 build in
  Playwright Chromium and verifies tabs, page reads, snapshots, links, typing,
  clicking, and navigation against a controlled local page. Its internal tool
  bridge is compiled out of production builds. The test also verifies stale
  revision, changed-target, cross-tab, navigation, and DOM-error rejection,
  controlled-input events, and navigation completion and timeout diagnostics.
- the extension background binds each snapshot ref to a Chrome tab id, main
  document id, and monotonic snapshot revision. Ref actions target the original
  document through `chrome.scripting` and validate the element's tag, role, and
  accessible name before acting.
- text entry bypasses framework value trackers through the native input or
  textarea setter, dispatches `beforeinput`, `input`, and `change`, and returns
  bounded diagnostics without echoing the entered text.
- navigation listens for tab loading and completion, applies a bounded timeout,
  and returns `complete`, `timeout`, or `closed` with final URL and elapsed time.
- generic MCP discovery preserves tool annotations. Chat Mode defaults unknown
  tools to denied unless annotations explicitly mark them read-only and
  non-destructive; Agent Mode continues to expose the discovered tool set.
- sensitive tool execution is gated in the native host by a one-time,
  run-bound, client-bound confirmation. Browser mutations, workspace writes,
  and MCP tools without trustworthy read-only metadata cannot run until the
  side panel approves them; visible arguments redact entered text, file content,
  and common secret fields.
- completed run diagnostics are detached from `agent.done`, stored in a bounded
  native registry, and fetched explicitly through `agent.run_details` when the
  user opens the per-answer detail panel.

Continue the split in small verified steps, preserving protocol behavior after
each extracted module. The target tree is directional, not a checklist: do not
extract code that would only add pass-through types or circular dependencies.

## Verification Strategy

Every release must pass:

```powershell
cd extension
npx playwright install chromium
npm run typecheck
npm run build
npm run test:extension-smoke

cd ..\native-host
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

cd ..
python scripts\test_native_protocol_e2e.py
```

`scripts/package_release.py` runs the extension smoke test and native unit tests
unless `--skip-tests` is explicitly supplied. It rebuilds the production
extension after the test-mode build before creating release archives.

When a DeepSeek test key is available, run the real-provider E2E without
persisting credentials in the repository:

```powershell
$env:DEEPSEEK_API_KEY = "<temporary-api-key>"
python ..\scripts\test_deepseek_e2e.py --model deepseek-v4-flash
Remove-Item Env:DEEPSEEK_API_KEY
```

The completed v0.2.0 gate has automated coverage for:

- settings round trips and save failures,
- multi-turn context ordering and limits,
- cancellation and concurrent request routing,
- extension-tool request correlation,
- Chat Mode mutation denial,
- workspace traversal and symlink rejection,
- MCP initialization, tool discovery, and tool errors,
- a Chrome extension smoke test using a test page.
