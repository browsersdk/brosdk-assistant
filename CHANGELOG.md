# Changelog

## Unreleased

### Changed

- Detached full prompts, model messages, tool schemas, and tool results from
  `agent.done`; the answer detail panel now loads bounded native-host diagnostics
  explicitly through `agent.run_details` and `run_id`.

## 0.2.0 - 2026-07-24

### Added

- Chrome Extension browser-tools mode that works without CDP or MCP.
- Active-tab reading, structured page snapshots, link extraction, navigation,
  clicking, and controlled-input typing.
- Scoped workspace list, read, search, write, and edit tools.
- Streaming agent runs, progress events, cancellation, and bounded host-owned
  conversation context.
- Generic MCP Streamable HTTP discovery, invocation, and session support.
- User confirmation for browser mutations, workspace writes, and MCP tools that
  are not explicitly read-only.
- Deterministic Native Messaging and Playwright extension smoke tests.
- Stable per-user Windows installation directory, upgrade state, uninstaller,
  release checksums, privacy policy, and security policy.

### Changed

- Chrome Extension browser tools are now the default; MCP is optional.
- Settings are owned by the native host and edited on a full-page options page.
- Chat Mode defaults unknown MCP tools to denied unless annotations explicitly
  mark them read-only without a destructive contradiction.
- Snapshot references are bound to their tab, document, and latest revision.

### Known Limitations

- Windows x64 is the only packaged platform.
- Installation uses an unpacked extension and browser Developer mode.
- Anthropic Messages API is not implemented.
- Conversations are not persisted after the native host exits.
- API keys are stored in the native settings file.
- Upgrading from v0.1.0 requires loading the new stable extension directory once
  and removing the old unpacked copy after verification.

## 0.1.0 - 2026-07-23

- Initial Windows preview with a Chrome side panel, Rust Native Messaging host,
  OpenAI-compatible model configuration, optional MCP connection, attached tabs,
  and workspace selection.
