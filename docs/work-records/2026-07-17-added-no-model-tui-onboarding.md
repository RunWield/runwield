---
kind: "work_record"
recordId: "539309ec-4d97-4968-9982-aea5d5c7a61c"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:43:58.804Z"
provenance:
    sourcePlans:
        - "3728aa70-5e7c-4af5-974c-5bc98127b9db"
---

# No-model TUI onboarding

## Summary

RunWield shows a themed welcome flow whenever no usable model is configured. It offers subscription or API-key login, opens model selection after login, persists the default, and initializes the root Agent Session. Esc quits, while failed or canceled setup restores input for recovery commands. A usable model bypasses onboarding.
