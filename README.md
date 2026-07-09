# Brosdk Assistant

Chrome side-panel assistant backed by a Rust Native Messaging host.

Read `docs/v2-plan.md` first for architecture and implementation notes.

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

## Native Messaging Smoke Test

The Rust host can be tested without Chrome by sending length-prefixed JSON to
stdin. The extension background uses the same framing through
`chrome.runtime.connectNative("com.browsersdk.assistant")`.
