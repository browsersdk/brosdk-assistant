# Privacy

Brosdk Assistant is local-first and does not include analytics, advertising,
or a project-operated telemetry service.

## Data Stored Locally

- Model and browser-tool settings are stored by the native host under
  `%APPDATA%\BrosdkAssistant\settings.json` on Windows.
- The selected API key is stored in that settings file and is not copied to
  Chrome local storage.
- Recent workspace paths are stored in extension-local storage.
- Conversation history is held in native-host memory and is not persisted.
- The default workspace is under `%APPDATA%\BrosdkAssistant\workspace`.

## Data Sent To Configured Services

The assistant sends data only as needed to services that the user configures:

- Prompts, conversation context, attached-tab metadata, and tool results may be
  sent to the configured model API. Tool results can contain page text or local
  workspace content requested by the user or model.
- When MCP mode is enabled, tool discovery and tool-call arguments are sent to
  the configured MCP endpoint.

The project does not proxy these requests or receive a copy of their contents.
The privacy terms of the selected model provider and MCP operator apply.

## Browser And Local Access

The extension requests access to browser tabs and page scripting so it can read
and control pages. Chat Mode exposes only read-only tools. Agent Mode can expose
mutating tools, but sensitive actions require explicit confirmation before the
native host executes them.

Workspace tools are available only after a workspace is selected and are scoped
to that directory. Parent traversal and symlink escapes are rejected.

## Deletion

The Windows uninstaller preserves settings by default. Run it with
`-RemoveSettings` to delete settings and the default workspace. Remove the
extension from the browser extensions page to delete extension-local storage.
