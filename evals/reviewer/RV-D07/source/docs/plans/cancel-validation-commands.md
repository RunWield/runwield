---
planId: cancel-validation-commands
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Cancel validation commands

## Request

Validation users need to stop an active command and receive a cancelled result after the command settles. Keep ordinary command results and output capture unchanged.

## Approved steps

1. Add cancellation to an active validation run.
2. Return a cancelled outcome after settlement; keep successful and failed command results.
3. Cover command output, nonzero exits, and an active cancellation with real subprocesses.

## Validation

Use Bun 1.4.3. Run `bun run test`.
