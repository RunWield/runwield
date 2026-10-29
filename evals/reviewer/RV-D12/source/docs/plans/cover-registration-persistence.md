---
planId: cover-registration-persistence
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Cover project registration persistence

## Request

Registration currently has little regression coverage. Add tests for a successful registration, catalog refusal, and
an already locked registry. A successful registration must be visible when the registry is opened again.
Keep the current registration API's result shape and error behavior. The catalog is a network boundary; tests should
not require network access.

## Approved steps

1. Add deterministic catalog fixtures.
2. Cover registration outcomes, including durable state after reopening.
3. Keep the architecture check in place and run normal tests.

## Validation

Run `bun run test` and `bun run seams:check`.
