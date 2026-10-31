---
kind: "work_record"
recordId: "0997e0f3-2a9d-48a7-bcd4-90048ff232cc"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:04.980Z"
provenance:
    sourcePlans:
        - "008736c6-9dde-4d0c-a6b2-ea86adc65398"
---

# Pi package slash prompt templates

## Summary

Installed Pi packages can contribute passive slash prompt templates without the executable-extension compatibility marker. Templates use the existing resource loader and retain source metadata. Executable extensions remain compatibility-gated.

## Out of Scope

This work does not include overrides of built-in slash commands.

## Future Planning Notes

Any prompt override policy must define trust, precedence, collision warnings, and explicit manifest opt-in.
