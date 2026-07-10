# Brosdk Assistant V2 Plan

This is the implementation plan for the new `brosdk-assistant` project.

## Goals

- Build a Chrome side-panel assistant that starts its local agent through Chrome
  Native Messaging.
- Replace the manual Python HTTP service startup from v1 with a Rust native
  host process managed by Chrome.
- Keep the extension UI responsive and event-driven.
- Use an original `message-bot` style icon inspired by common message and bot
  icon patterns, without copying Font Awesome assets.
- Keep product identity, source code, and UI implementation independent.

## Architecture

```text
Chrome side panel React UI
  -> extension background service worker
  -> chrome.runtime.connectNative("com.browsersdk.assistant")
  -> Rust native host
  -> MCP / browser automation / LLM / workspace tools
```

The extension should not open a localhost HTTP server by default. Native
Messaging is the primary transport between Chrome and the local agent.

## Process Model

Chrome starts the Rust native host when the background service worker calls:

```ts
chrome.runtime.connectNative('com.browsersdk.assistant')
```

The host communicates with Chrome over stdin/stdout using the Native Messaging
framing format:

- 4-byte little-endian unsigned message length.
- UTF-8 JSON payload.
- Host logs must go to stderr or a log file, never stdout.

Chrome limits messages from the native host to 1 MB each, so streaming content
must be chunked.

## Extension Structure

Current files:

- `extension/entrypoints/background.ts`
  - Owns the native port.
  - Reconnects on disconnect.
  - Routes request/response ids.
  - Broadcasts host events to side-panel views.
  - Configures global side-panel behavior.
  - Syncs settings from the native host after the native port connects.
- `extension/entrypoints/sidepanel/`
  - React side-panel entrypoint.
- `extension/entrypoints/settings/`
  - Full-page extension settings entrypoint.
  - Replaces the old embedded `options_ui` popup because the configuration UI
    needs more horizontal and vertical space than Chrome's options popup gives.
- `extension/src/nativeClient.ts`
  - Side-panel client for background RPC/events.
- `extension/src/App.tsx`
  - Main UI.
- `extension/src/types.ts`
  - Shared protocol and UI types.
- `extension/public/icons/`
  - Generated extension icons.

## Rust Native Host Structure

Planned files:

- `native-host/src/main.rs`
  - Native Messaging read/write loop.
  - JSON-RPC style request dispatcher.
  - Event sender.
- `native-host/native-host-manifest.example.json`
  - Chrome native host manifest template.
- `native-host/scripts/install-windows.ps1`
  - Writes the native host manifest and registry key for Chrome.

Future modules can split into:

- `protocol`
- `settings`
- `mcp`
- `agent`
- `workspace`
- `tabs`

## Protocol

Use a JSON-RPC-like envelope over Native Messaging.

Request:

```json
{ "id": "1", "method": "agent.health", "params": {} }
```

Response:

```json
{ "id": "1", "result": { "ok": true, "service": "brosdk-assistant-native" } }
```

Error response:

```json
{ "id": "1", "error": { "code": "unknown_method", "message": "Unknown method" } }
```

Event:

```json
{ "event": "agent.status", "payload": { "state": "ready" } }
```

Initial methods:

- `agent.health`
- `agent.echo`
- `agent.run`
- `agent.tools`
- `llm.tools`
- `agent.cancel`
- `agent.reset`
- `tabs.list`
- `tabs.active`
- `filesystem.roots`
- `filesystem.list`
- `workspace.set`
- `settings.get`
- `settings.set`

Initial persisted settings:

- `browser_tools_mode`
- `mcp_url`
- `model_base_url`
- `model_name`
- `model_api_type`
- `api_key`
- `temperature`
- `workspace_dir`

The first Rust implementation stores settings in the user profile:

- Windows: `%APPDATA%\BrosdkAssistant\settings.json`
- Other platforms: `$HOME/BrosdkAssistant/settings.json`

The native host is the single source of truth for persisted configuration. The
extension must not persist model, MCP, API key, side-panel, or workspace
configuration in `chrome.storage.local`.

Current extension behavior:

- Settings page load:
  - call `settings.get` through Native Messaging.
  - populate the form from the native response.
  - show an error if the native host is not connected.
- Settings page save:
  - call `settings.set`.
  - notify the background script with an in-memory `settings.changed` message so
    side-panel behavior can update immediately.
- Background startup / native ready:
  - call `settings.get`.
  - update cached side-panel behavior from the native response.
- Legacy cleanup:
  - remove the old `chrome.storage.local` key `brosdk-assistant-settings`.

The extension may still use `chrome.storage.local` for UI-only state, such as
recent workspace folder shortcuts. That UI memory is not configuration.

Workspace defaults:

- `workspace_dir = "."` means the native default workspace.
- Native default workspace:
  - Windows: `%APPDATA%\BrosdkAssistant\workspace`
  - Other platforms: `$HOME/BrosdkAssistant/workspace` equivalent under the
    native settings base directory.
- `workspace_dir = ""` means "No workspace"; local workspace tools are not
  exposed to the model.

Initial events:

- `native.ready`
- `agent.status`
- `agent.delta`
- `agent.done`
- `agent.error`
- `tabs.changed`

## Browser Tools Source

The settings page exposes `browser_tools_mode`:

- `mcp`
  - use the configured MCP URL.
  - native-host discovers tools with `tools/list` and forwards calls with
    `tools/call`.
  - best for CDP-backed browser automation servers.
- `extension`
  - do not require MCP or CDP for browser page tools.
  - native-host exposes built-in `browser_*` tools to the model.
  - tool calls are sent to the extension background as
    `extension.tool.request` events over Native Messaging.
  - the extension executes Chrome API or `chrome.scripting.executeScript`
    operations and sends the result back through the native port.
- `off`
  - expose no browser page tools.
  - model chat and workspace tools can still work.

Chrome Extension mode currently provides:

- `browser_tabs`
- `browser_active_tab`
- `browser_read_page`
- `browser_snapshot`
- `browser_extract_links`
- `browser_navigate`
- `browser_click`
- `browser_type`

Chat Mode exposes only read-only extension browser tools. Agent Mode also
exposes navigation, click, and type tools.

`browser_snapshot` returns interactive elements with refs such as `e12`.
`browser_click` and `browser_type` should prefer those refs over CSS selectors
or text matching.

Extension mode is intentionally a lighter fallback than CDP-backed MCP:

- it cannot inject into protected browser pages such as `chrome://` pages.
- it has weaker frame, accessibility tree, screenshot, download, upload, and
  file-picker support than CDP.
- clicks and typing are best-effort DOM operations.

## MCP Tool Conversion

The Rust native host owns MCP tool discovery and LLM tool conversion. The
extension should not convert MCP tools itself.

Current flow:

```text
agent.run / agent.tools / llm.tools
  -> initialize MCP Streamable HTTP session
  -> notifications/initialized
  -> tools/list
  -> sanitize MCP tool names for OpenAI-compatible function names
  -> convert each MCP tool to:
     { type: "function", function: { name, description, parameters } }
  -> return tool_name_map so safe LLM tool names can be mapped back to MCP names
```

Tool name constraints follow OpenAI-compatible function calling requirements:

```text
^[a-zA-Z0-9_-]+$
```

Names containing `/`, `.`, `:`, spaces, or other invalid characters are replaced
with `_` and receive a short SHA-1 suffix when needed. The safe name length is
capped at 64 characters.

The native host should remain MCP-server agnostic:

- It discovers tools with `tools/list`.
- It forwards tool calls through `tools/call`.
- It does not require vendor-specific browser APIs.
- It keeps a `tool_name_map` to map OpenAI-safe function names back to original
  MCP tool names.

Chat Mode applies a conservative compatibility layer for known browser MCP
tools:

- Known read-only browser tools are exposed.
- Known mutating browser tools such as `act`, `navigate`, `upload`, `download`,
  `run`, and `evaluate` are hidden.
- `tabs` remains available, but only `action="list"` and `action="active"` are
  allowed.
- Unknown external MCP tools are left available for compatibility unless a later
  policy decides to require `annotations.readOnlyHint`.

## Tab Strategy

The extension can still read Chrome tabs directly for UI context because Chrome
tab activation is an extension-level event. The native host should expose tabs
methods for future non-extension contexts, but the first version can return
placeholder data until browser/MCP integration is added.

Attached tabs are UI context, not page content. The extension sends selected
tabs as:

```json
{ "tabId": 123, "title": "Example", "url": "https://example.com" }
```

For browser-control MCP servers, the model should call `tabs` with
`action="list"` and match:

```text
attached_tabs[].tabId == pages[].tabId
```

The MCP `pages[].page` value is the page id to pass to `read`, `snapshot`,
`grep`, `act`, or `navigate`.

For "current page" requests, attached tabs are not required; the model should
use `tabs` with `action="active"` and then read the returned page id.

## Workspace Tools

The native host exposes scoped local workspace tools only when a workspace is
selected or when the default workspace is active.

Agent Mode workspace tools:

- `workspace_ls`
- `workspace_read_file`
- `workspace_write_file`
- `workspace_edit_file`
- `workspace_search`

Chat Mode workspace tools:

- `workspace_ls`
- `workspace_read_file`
- `workspace_search`

All workspace paths must be relative to the selected workspace. The native host
rejects:

- absolute paths.
- `..` parent traversal.
- canonical paths that resolve outside the workspace.
- symlink escapes outside the workspace.

The default workspace is created by the native host when needed. Selecting
"No workspace" disables workspace tools entirely.

## Chat Mode vs Agent Mode

The side panel has two user-facing modes:

- `Agent Mode`
  - full browser MCP tools.
  - full workspace tools when a workspace exists.
  - can act, navigate, write files, and edit files when requested.
- `Chat Mode`
  - read-only browser and workspace behavior.
  - can inspect current/attached pages.
  - can read/search workspace files.
  - cannot click, type, navigate, create/close tabs, write files, or edit files.

The mode is passed from the side panel to `agent.run` as `mode: "chat" |
"agent"`. The native host uses it for:

- tool filtering.
- `tabs` action guarding.
- workspace tool gating.
- system prompt mode guidance.

The UI controls mode selection, while the native host enforces tool filtering
and action limits.

## Response Debug Details

Assistant messages include a small details button. The message body should show
only the assistant answer. Diagnostic information belongs in the details panel,
including:

- system prompt.
- user message.
- attached tabs context.
- messages sent to the model.
- LLM tool count.
- MCP tool count.
- workspace tool count.
- tool name map.
- tool definitions.
- tool results.

The side panel renders assistant message Markdown directly in the chat body and
keeps tool-preparation summaries out of the visible answer.

## First Implementation Milestone

Milestone 1 should provide a complete local communication loop:

1. WXT extension builds.
2. Background configures side panel and native host port.
3. Side panel can call `agent.health`.
4. Rust native host responds to `agent.health`, `settings.get`,
   `settings.set`, `agent.echo`, `agent.run`, `agent.tools`, `llm.tools`,
   `filesystem.roots`, and `filesystem.list`.
5. Native host manifest template and Windows install script exist.
6. Project docs explain installation and verification.

## Risks and Notes

- Native host registration requires a stable extension id in `allowed_origins`.
  During development, set a fixed extension key or update the native host
  manifest after loading the extension.
- The native host process lifetime is tied to Chrome's native port. If the port
  disconnects, Chrome may terminate the host.
- stdout is protocol-only. Any accidental stdout logging breaks framing.
- Long model output must stream as small `agent.delta` events.
- If multiple side-panel views open, the background script should multiplex them
  over one native port.
