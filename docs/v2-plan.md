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
- element refs are not yet stable across DOM changes,
- click and text input are best-effort DOM operations,
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
  "result": { "run_id": "run-1", "state": "queued" }
}
```

The host then emits bounded events:

- `agent.status`
- `agent.tool.started`
- `agent.tool.finished`
- `agent.done`
- `agent.error`
- `agent.cancelled`

`agent.cancel` takes a `run_id`. The host must continue routing health,
settings, and tool responses while a run is active. No request may be consumed
and discarded while waiting for another response.

Implemented behavior:

- the stdout writer serializes all responses and events,
- the main input loop remains available while runs execute on worker threads,
- extension-tool responses are correlated through per-call waiters,
- cancellation is acknowledged immediately and suppresses late run events,
- tool failures are returned to the model when recovery is possible,
- `agent.run` remains as a blocking compatibility entrypoint.

Remaining v0.2.0 work:

- stream provider output through `agent.delta`,
- interrupt an in-flight blocking HTTP request instead of only suppressing its
  late result,
- move conversation ownership from the side panel to the native host,
- split the native host into protocol, provider, agent, and tool modules.

Native Messaging output is limited to 1 MB per message. Large model output,
debug traces, page data, and tool results must be chunked or fetched separately
by identifier.

## Conversation Context

- A conversation has a stable identifier.
- Prior user and assistant messages are sent in order.
- Tool calls and tool results stay paired.
- Context is bounded by message count and serialized size before provider calls.
- New Chat creates a new context rather than only clearing visible UI.
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

The current single-file host should be split along ownership boundaries:

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

The split should happen while implementing the asynchronous run protocol, not
as an unrelated rewrite.

## Verification Strategy

Every release must pass:

```powershell
cd extension
npm run typecheck
npm run build

cd ..\native-host
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

When a DeepSeek test key is available, run the real-provider E2E without
persisting credentials in the repository:

```powershell
$env:DEEPSEEK_API_KEY = "<temporary-api-key>"
python ..\scripts\test_deepseek_e2e.py --model deepseek-v4-flash
Remove-Item Env:DEEPSEEK_API_KEY
```

The v0.2.0 gate also requires automated coverage for:

- settings round trips and save failures,
- multi-turn context ordering and limits,
- cancellation and concurrent request routing,
- extension-tool request correlation,
- Chat Mode mutation denial,
- workspace traversal and symlink rejection,
- MCP initialization, tool discovery, and tool errors,
- a Chrome extension smoke test using a test page.
