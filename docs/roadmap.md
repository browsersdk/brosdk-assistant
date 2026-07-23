# Brosdk Assistant Product Roadmap

## Direction

Brosdk Assistant should become a dependable local-first browser assistant, not
a broad collection of partially connected features.

The product promise is:

> Ask about the page, act in the browser when permitted, and optionally work
> with local files or MCP tools without depending on a proprietary browser API.

BrowserOS remains a useful workflow reference. Product identity, UI language,
implementation, and protocols remain independent.

## Product Principles

1. **Works after installation.** Chrome Extension tools are the default; MCP is
   optional.
2. **Capability claims are truthful.** Unimplemented providers and controls are
   not presented as working features.
3. **Read-only by default.** Chat Mode is safe for inspection. Mutations are
   explicit and policy-enforced.
4. **Failures are visible and recoverable.** Saving, model calls, MCP calls, and
   tool calls return actionable errors.
5. **Context is intentional.** Current page, attached tabs, workspace, and
   conversation history have distinct meanings.
6. **Local access is scoped.** Workspace tools never escape the selected root.
7. **MCP stays generic.** Tool discovery and invocation do not depend on one MCP
   implementation.

## Primary User Journeys

### Ask about the current page

- Open the side panel.
- Ask for a summary or explanation.
- The assistant resolves the active tab and reads the page.
- No attached tab or MCP server is required.

### Work across selected tabs

- Attach one or more tabs.
- Ask about "these tabs" or "selected tabs".
- The assistant uses the attached tab ids as the explicit target set.

### Complete a browser task

- Switch to Agent Mode.
- The assistant inspects the page before acting.
- Sensitive actions require confirmation.
- The UI shows tool progress and the final outcome.

### Produce or inspect local files

- Select a workspace.
- Chat Mode may read and search.
- Agent Mode may write and edit after applicable confirmation.
- No workspace means no filesystem tools.

## Current Baseline

Available today:

- Chrome side-panel and full-page settings UI,
- Rust Native Messaging host,
- OpenAI-compatible Chat Completions,
- generic MCP Streamable HTTP discovery and calls,
- Chrome Extension browser tools,
- scoped workspace tools,
- Chat and Agent tool filtering,
- attached tabs and workspace selection,
- response Markdown and run details,
- Windows release packaging.

Known gaps:

- host-owned conversation state is memory-only and not searchable or persisted,
- most native agent and tool code remains concentrated in `main.rs`,
- Anthropic is not implemented,
- extension element refs are not stable across page changes,
- destructive actions have no confirmation layer,
- extension and protocol integration tests are missing,
- installation is still a developer-oriented workflow.

## Milestones

### v0.1.1 - Truthful Baseline

Goal: remove misleading defaults and make the existing path dependable.

Status: completed.

- Default new installations to Chrome Extension browser tools.
- Keep Anthropic visible only as unavailable until its adapter works.
- Propagate settings persistence errors and avoid partial in-memory saves.
- Include bounded prior messages in each model call.
- Remove controls that imply unsupported cancellation.
- Show the active Chat/Agent and browser-tool source in the side panel.
- Bring format, lint, tests, typecheck, and build to green.

Exit criteria:

- A new installation does not contact MCP unless the user selects MCP.
- A failed settings write is reported as a failed save.
- A follow-up question can reference the previous answer.
- Every visible provider and control behaves as described.

### v0.2.0 - Reliable Conversation Core

Goal: make runs observable, cancellable, concurrent-safe, and testable.

Status: in progress. The `run_id` protocol, concurrent request routing, SSE
`agent.delta` output, streamed tool-call reconstruction, tool events,
cooperative cancellation, host-owned bounded conversations, per-side-panel
event routing, cancellable model HTTP I/O, and DeepSeek E2E coverage are
implemented. The OpenAI provider and Native Messaging protocol have been
extracted from `main.rs`; agent and tool extraction plus broader integration
tests remain.

- Add `run_id` based asynchronous agent protocol.
- Stream model deltas and tool progress events.
- Implement real cancellation and suppress late results.
- Route settings, health, cancellation, and extension-tool responses while a run
  is active.
- Introduce provider and tool execution interfaces.
- Split the native host by protocol, settings, provider, agent, and tool
  ownership.
- Bound context by message count and serialized size.
- Return recoverable tool failures to the model.
- Add request timeouts, retries where safe, and structured error codes.
- Add native protocol integration tests and extension unit tests.

Exit criteria:

- No request is lost during a model or extension-tool call.
- Cancellation is acknowledged quickly and the cancelled run produces no late
  assistant message.
- Long answers visibly stream without exceeding Native Messaging limits.
- New Chat creates a new conversation context.

### v0.3.0 - Trustworthy Browser Agent

Goal: make browser actions robust enough for repeated daily use.

- Bind snapshot refs to a tab, document, and revision.
- Improve controlled-input typing and event dispatch.
- Add wait, scroll, select, keyboard, tab lifecycle, and screenshot tools.
- Represent frame and shadow-root limitations clearly.
- Add action confirmations and policy decisions to run details.
- Default-deny unknown MCP tools in Chat Mode unless metadata marks them
  read-only.
- Add tool-call budgets and loop diagnostics.
- Add browser E2E coverage for summaries, forms, navigation, and cancellation.

Exit criteria:

- A curated browser task suite completes reliably in both Extension and MCP
  modes.
- Chat Mode cannot mutate browser or workspace state through unknown tools.
- Sensitive actions never execute without a recorded user decision.

### v0.4.0 - Distribution and Operations

Goal: make installation, updates, and support suitable for users outside the
development team.

- Use a stable extension identity for packaged installs.
- Provide signed native-host installers and uninstallers.
- Add startup diagnostics and repair guidance.
- Store secrets using platform credential facilities.
- Add CI for Rust, extension, packaging, and release checksums.
- Add version migration for settings and protocol compatibility.
- Publish license, privacy, security, and contribution documents.
- Add macOS and Linux packaging after the Windows path is stable.

Exit criteria:

- Installation does not require editing manifests by hand.
- Upgrade and uninstall preserve or remove user data predictably.
- Release artifacts are reproducible and verified in CI.

## Later Differentiation

After the reliability and trust milestones:

- multi-tab research with page-level citations,
- workspace artifacts generated from browser context,
- reusable task recipes,
- provider profiles and model routing,
- searchable local conversation history,
- run replay and failure recovery,
- richer generic MCP capability management.

## Measures

The roadmap should be judged by behavior, not feature count:

- first successful answer after setup,
- successful follow-up questions using prior context,
- completion rate on a fixed browser task suite,
- cancellation latency and absence of late results,
- percentage of failures with actionable error messages,
- zero mutation escapes from Chat Mode,
- release installation and upgrade success.

## Immediate Implementation Order

1. Commit and package the v0.1.1 truthful baseline.
2. Design and test the `run_id` protocol before adding more browser tools.
3. Move the native host to concurrent-safe run coordination.
4. Add streaming, cancellation, and host-owned conversation state.
5. Improve browser action quality and confirmations.
6. Harden packaging, security, and cross-platform installation.
