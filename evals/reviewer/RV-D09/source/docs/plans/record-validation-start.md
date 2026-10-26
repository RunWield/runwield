---
planId: record-validation-start
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Record validation start

## Request

Starting validation updates the Plan status and runs a configured external command. If that command fails, restore the earlier lifecycle metadata and report the failure. The command is supplied as an executable and arguments.

## Approved steps

1. Add a validation-start transition and run the configured external command.
2. Persist the new status on success and restore lifecycle metadata on command failure.
3. Cover successful and failed validation starts using real Plan files and commands.

## Validation

Use Bun 1.4.3. Run `bun run test`.
