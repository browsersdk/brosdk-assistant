# Brosdk Assistant

Brosdk Assistant is a local-first Chrome and Edge side-panel assistant backed by
a Rust Native Messaging host. It can answer questions about the current page,
use browser tools without CDP, connect to a generic MCP server, and work inside
an explicitly selected local workspace.

## Windows Quick Start

### Requirements

- Windows 10 or Windows 11, x64
- A current Chrome or Microsoft Edge installation
- An API key for an OpenAI-compatible Chat Completions provider

### Install

1. Download `brosdk-assistant-v0.2.0-windows.zip` from the GitHub Release.
   The standalone extension ZIP is intended for store submission and extension
   development, not direct Windows installation.
2. Extract the Windows package to any temporary directory.
3. Open PowerShell in the extracted package directory and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\scripts\install-windows.ps1
```

4. On first installation, the script copies the extension and native host to:

```text
%LOCALAPPDATA%\BrosdkAssistant
```

5. The script displays the stable extension directory. Open
   `chrome://extensions` or `edge://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select that directory.
6. Copy the extension ID from the browser and paste it into the waiting
   PowerShell prompt.
7. Reload the extension, open its options page, and configure the model.

The extension ID is saved for future upgrades. The installer registers only
Chrome by default. Use `-Browsers Chrome,Edge` when both browsers should use the
same installation.

### Configure

Open the extension options page and set:

- **API type:** OpenAI API
- **Base URL:** the provider's OpenAI-compatible API base URL
- **API key:** your provider API key
- **Model name:** a model supported by that provider
- **Browser tools:** Chrome Extension, MCP Server, or Off

`Chrome Extension` is the default and does not require CDP or an MCP server.
Choose `MCP Server` only when a compatible Streamable HTTP MCP endpoint is
already running.

Settings are owned by the native host and stored at:

```text
%APPDATA%\BrosdkAssistant\settings.json
```

The API key is currently stored in that settings file. Restrict access to your
Windows account and see [PRIVACY.md](PRIVACY.md) for the data-flow summary.

### Verify

1. Open the assistant side panel.
2. Confirm the status reports that the native host is connected.
3. In Chat Mode, ask: `Summarize this page.`
4. Switch to Agent Mode before requesting navigation, clicks, typing, or local
   file changes. Sensitive actions require an explicit approval in the side
   panel before the native host executes them.

## Update

1. Download and extract the new Windows package.
2. Close Chrome and Edge.
3. Run `install-windows.ps1` from the new package.
4. Reopen the browser and reload the extension.

The installer updates files under the stable LocalAppData directory and reuses
the saved extension ID and browser registrations.

Upgrading from v0.1.0 is a one-time migration: the new installer has no saved
installation state, so follow the first-install prompt and load the displayed
stable extension directory. After v0.2.0 is working, remove the old unpacked
copy from the browser. Existing native-host settings remain available.

## Uninstall

Close Chrome and Edge, then run:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\BrosdkAssistant\uninstall-windows.ps1"
```

This removes the native-host registrations and installed application files but
preserves settings. Add `-RemoveSettings` to also delete settings and the default
workspace. Finally remove Brosdk Assistant from the browser extensions page.

## Troubleshooting

### Specified native messaging host not found

- Reload the extension after running the installer.
- Confirm the extension ID pasted into the installer matches the currently
  loaded extension.
- Run the installer again if the extension was removed and loaded from another
  directory.
- Open the options page; it reports whether the native host is connected and
  shows the underlying error.

### The extension asks for MCP even in Chrome Extension mode

Open the options page, select `Chrome Extension`, save, and verify the success
message. MCP is optional and should not be contacted in this mode.

### A page cannot be read or controlled

Chrome blocks script injection on internal pages such as `chrome://` pages, the
Chrome Web Store, and some protected browser surfaces. Open a normal HTTP or
HTTPS page and retry.

### Agent Mode is waiting for approval

The native host pauses before browser mutations, workspace writes, and MCP tools
that are not explicitly marked read-only. Approve or deny the action in the side
panel. Closing the side panel leaves the request pending until it times out.

## Modes And Tools

- **Chat Mode:** exposes read-only browser, workspace, and MCP capabilities.
- **Agent Mode:** exposes action tools, with sensitive operations gated by user
  confirmation.
- **Chrome Extension:** reads pages, lists tabs, creates structured snapshots,
  extracts links, navigates, clicks, and types through Chrome APIs.
- **MCP Server:** discovers tools from a generic Streamable HTTP MCP endpoint.
  Unknown tools are hidden in Chat Mode unless standard annotations mark them
  read-only without a contradictory destructive hint.
- **Off:** disables browser tools while model chat and selected-workspace tools
  remain available.

Workspace tools are exposed only after a workspace is selected. All paths are
scoped to that root, and symlink or parent traversal escapes are rejected.

## Known Limitations

- Windows x64 is the only packaged platform in v0.2.0.
- The extension is installed unpacked and requires Developer mode.
- Anthropic Messages API is not implemented; Anthropic remains unavailable in
  the options page.
- Conversation state is memory-only and resets when the native host exits.
- Extension snapshots do not fully represent every iframe or shadow root.
- API keys are stored in the native settings file rather than Windows Credential
  Manager.

## Development

### Structure

- `extension/` - WXT, React, and Chrome MV3 extension code
- `native-host/` - Rust Native Messaging host
- `scripts/` - deterministic E2E and release packaging scripts
- `docs/` - roadmap and architecture plan

### Verify Native Host

```powershell
cd native-host
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

### Verify Extension

```powershell
cd extension
npm install
npx playwright install chromium
npm run generate:icons
npm run typecheck
npm run test:extension-smoke
npm run build
```

The extension smoke test loads a test-mode MV3 build in Playwright Chromium and
verifies tab discovery, page reading, snapshots, link extraction, typing,
clicking, navigation, stale-ref rejection, controlled-input events, and bounded
navigation diagnostics. Its internal test bridge is compiled out of production
builds.

The deterministic Native Messaging E2E requires no external credentials:

```powershell
python scripts\test_native_protocol_e2e.py
```

The optional real-provider E2E reads its API key only from the environment:

```powershell
$env:DEEPSEEK_API_KEY = "<temporary-api-key>"
python scripts\test_deepseek_e2e.py --model <supported-model-name>
Remove-Item Env:DEEPSEEK_API_KEY
```

## Package A Windows Release

Install Playwright Chromium once, then run from the repository root:

```powershell
python scripts\package_release.py --version 0.2.0
```

The packager runs extension typecheck and smoke tests, builds both components,
runs Rust tests, creates the Windows package and standalone extension ZIP, and
writes SHA-256 checksums to `.output/release/`.

## Project Documents

- [CHANGELOG.md](CHANGELOG.md)
- [docs/roadmap.md](docs/roadmap.md)
- [docs/v2-plan.md](docs/v2-plan.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)

Licensed under the [MIT License](LICENSE).
