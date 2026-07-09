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
- Keep BrowserOS as a reference only. This project remains independent.

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

Planned files:

- `extension/entrypoints/background.ts`
  - Owns the native port.
  - Reconnects on disconnect.
  - Routes request/response ids.
  - Broadcasts host events to side-panel views.
  - Configures global side-panel behavior.
- `extension/entrypoints/sidepanel/`
  - React side-panel entrypoint.
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
- `agent.cancel`
- `agent.reset`
- `tabs.list`
- `tabs.active`
- `workspace.set`
- `settings.get`
- `settings.set`

Initial events:

- `native.ready`
- `agent.status`
- `agent.delta`
- `agent.done`
- `agent.error`
- `tabs.changed`

## Tab Strategy

The extension can still read Chrome tabs directly for UI context because Chrome
tab activation is an extension-level event. The native host should expose tabs
methods for future non-extension contexts, but the first version can return
placeholder data until browser/MCP integration is added.

## First Implementation Milestone

Milestone 1 should provide a complete local communication loop:

1. WXT extension builds.
2. Background configures side panel and native host port.
3. Side panel can call `agent.health`.
4. Rust native host responds to `agent.health`, `settings.get`,
   `settings.set`, and `agent.echo`.
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

