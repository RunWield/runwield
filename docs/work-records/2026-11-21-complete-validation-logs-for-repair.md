---
kind: "work_record"
recordId: "9bc48521-3a7c-4e4f-b184-84e50205a302"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-21T18:45:29.365Z"
provenance:
    sourcePlans:
        - "34978ff1-2070-481d-96bc-2aa16475d4ca"
---
# Complete validation logs for repair

## Summary

RunWield saves complete, combined stdout and stderr output from Verification Commands in the execution checkout’s `.wld/internal/validation-logs/`, with serialized writes that preserve chunk arrival order. Repair requests, Delivery Evidence, Connect host packets, and TUI results carry a tail capped at 200 lines and 16,384 bytes, plus truncation counts when needed and the absolute log path. Managed, Connect, and QUICK_FIX repair instructions direct readers to the start of the log when the tail may hide the first failure, so repairs can distinguish early errors from later timeouts or related failures. Log failures report the reason without changing the command’s result or exit code.

## Out of Scope

This work does not include changes to worktree setup output or Epic integration output capture.

## Future Planning Notes

The formatted `output` string owns the tail and log reference; consumers do not require separate log-path fields or changed result types. Logs remain local to the execution checkout, with retention of the newest 20 logs, and worktree removal deletes them. Historical evidence can therefore retain a path to a deleted log; its inline tail remains available. Missing commands and spawn failures keep their existing messages and create no log.
