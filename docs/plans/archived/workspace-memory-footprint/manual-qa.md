# Manual QA for workspace-memory-footprint

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="workspace-memory-footprint/01-reuse-workspace-renderer" -->

## Reuse the Workspace Page Renderer

Manual verification steps for workspace-memory-footprint/01-reuse-workspace-renderer

- [ ] Start the isolated fixture server and record the localhost URL it prints.
- [ ] In a uniquely named `agent-browser` session, navigate between two Sessions, two Plans, Plan Review, Code Review,
      and a question page ten times; confirm each page shows the current content and loads successfully.
- [ ] Edit a Plan body, revisit the Plan, and confirm the updated content appears.
- [ ] Confirm review controls work, Plan links and editing work, and authentication still protects restricted pages.
- [ ] Check the browser console and network responses for errors, then confirm the server memory samples are recorded.

<!-- runwield:manual-qa:end child="workspace-memory-footprint/01-reuse-workspace-renderer" -->

<!-- runwield:manual-qa:start child="workspace-memory-footprint/02-release-operation-payloads-and-bound-streams" -->

## Release Finished Operation Payloads and Bound Observation Streams

Manual verification steps for workspace-memory-footprint/02-release-operation-payloads-and-bound-streams

- [ ] Open a uniquely named Workspace session in the fixture server, start and continue an operation, then confirm the
      current output and saved conversation appear after completion.
- [ ] Complete an operation before opening its stream; confirm the Agent-stop alert appears once and does not replay
      after reload.
- [ ] Throttle or pause an operation stream while updates arrive; confirm the latest content and final status appear,
      with no repeated obsolete snapshots.
- [ ] Disconnect the browser during a pending question, review, or background task; reconnect and confirm the work
      remains available in the same Session and completes normally.
- [ ] Force fallback polling, switch Sessions while a response is pending, and reconnect after completion; confirm there
      is no false interruption, stale content, or overlapping poll.

<!-- runwield:manual-qa:end child="workspace-memory-footprint/02-release-operation-payloads-and-bound-streams" -->
