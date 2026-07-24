# Security Policy

## Supported Versions

Security fixes are provided for the latest published version. Older preview
versions may be asked to upgrade before a report is investigated.

## Reporting A Vulnerability

Please use GitHub's private vulnerability reporting for this repository when it
is available. Do not open a public issue containing API keys, private page data,
local file contents, or exploit details.

Include the affected version, operating system, browser, reproduction steps,
and the impact. Remove or replace secrets and personal data from logs.

## Security Boundaries

- Chat Mode is intended to remain read-only.
- Agent Mode requires confirmation for browser mutations, workspace writes, and
  MCP tools that are not explicitly read-only.
- Workspace paths must remain inside the selected root.
- Native Messaging accepts messages only from extension origins listed in the
  installed host manifest.

MCP annotations are capability hints supplied by the configured MCP server.
Users should connect only to MCP endpoints they trust.
