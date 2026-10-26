---
planId: resume-after-repair
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Resume validation after repair

## Request

Validation can request an isolated repair task. Add completion delivery so validation can continue when that task finishes, including after an application restart.

## Approved steps

1. Record repair completion evidence and expose completion delivery on the application service.
2. Resume checks after a completed repair and support reopening saved validation state.
3. Cover ordinary task completion, live repair completion, and reopening durable state.

## Validation

Use Bun 1.4.3. Run `bun run test`.
