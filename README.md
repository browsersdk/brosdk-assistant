# Brosdk Assistant

Local-first Chrome side-panel assistant backed by a Rust Native Messaging host.

Start with:

- `docs/roadmap.md` for product direction, milestones, and release gates.
- `docs/v2-plan.md` for current and target architecture.

## Structure

- `extension/` - WXT + React Chrome extension.
- `native-host/` - Rust Native Messaging host.
- `docs/` - planning and handoff notes.

## Verify

```powershell
cd native-host
cargo check
cargo build --release
```

```powershell
cd extension
npm install
npm run generate:icons
npm run typecheck
npm run build
```

## Package Windows Release

Use the release packager from the repository root:

```powershell
python scripts\package_release.py --version 0.1.0
```

The script runs extension typecheck/build/zip, runs native-host tests, builds
the release native host, and writes release assets to `.output/release/`:

- `brosdk-assistant-v0.1.0-windows.zip` - Windows install package.
- `brosdk-assistant-extension-v0.1.0-chrome.zip` - standalone extension zip.

The Windows install package contains only `extension/chrome-mv3` for unpacked
extension loading. The standalone extension zip is kept as a separate asset to
avoid duplicate extension payloads inside the package.

## Native Host Install On Windows

1. Build the native host:

```powershell
cd native-host
cargo build --release
```

2. Build or run the extension, then load `extension/dist/chrome-mv3` or the WXT
   dev output in `chrome://extensions`.

3. Copy the loaded extension id.

4. Register the native host for that extension id:

```powershell
native-host\scripts\install-windows.ps1 -ExtensionId <chrome-extension-id>
```

The script writes `native-host/native-host-manifest.json` and registers:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browsersdk.assistant
```

Reload the extension after registration.

## Current Settings

The side panel Settings panel stores these values through the Rust native host:

- browser tools source: MCP Server, Chrome Extension, or Off
- MCP URL, required only when browser tools source is MCP Server
- model API type; OpenAI-compatible APIs are supported and Anthropic is planned
- model base URL
- model name
- model API key
- temperature
- workspace folder

On Windows, native-host settings are saved under:

```text
%APPDATA%\BrosdkAssistant\settings.json
```

Browser tools source controls how the assistant reads or acts on browser pages:

- `Chrome Extension` is the default for new installations.
- `MCP Server` uses the configured MCP URL and is best when a CDP-backed MCP
  server is running.
- `Chrome Extension` uses extension APIs and injected scripts, so it can read
  page text, list tabs, snapshot actionable elements, extract links, navigate,
  click, and type without CDP.
- `Off` disables browser page tools while keeping model chat and workspace
  tools available.

## Native Messaging Smoke Test

The Rust host can be tested without Chrome by sending length-prefixed JSON to
stdin. The extension background uses the same framing through
`chrome.runtime.connectNative("com.browsersdk.assistant")`.

## DeepSeek End-to-End Test

The real-provider E2E test starts the native host with a temporary settings
directory and verifies Native Messaging, settings persistence, an OpenAI-
compatible model request, a scoped workspace tool call, and multi-turn context.
The API key is read only from the environment and is not written to the
repository.

The test also verifies the asynchronous `agent.start` protocol, concurrent
`agent.health` routing during a model run, tool progress events, and
`agent.cancel` acknowledgement.

```powershell
$env:DEEPSEEK_API_KEY = "<temporary-api-key>"
python scripts\test_deepseek_e2e.py --model deepseek-v4-flash
Remove-Item Env:DEEPSEEK_API_KEY
```

Optional environment variables:

- `DEEPSEEK_BASE_URL`, default `https://api.deepseek.com`
- `DEEPSEEK_MODEL`, default `deepseek-v4-flash`

The Anthropic-compatible DeepSeek endpoint is not tested until the native host
has an Anthropic Messages API adapter.

Validated on 2026-07-23 with:

- `deepseek-v4-flash`
- `deepseek-v4-pro`
