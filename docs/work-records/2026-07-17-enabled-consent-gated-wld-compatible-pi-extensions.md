---
kind: "work_record"
recordId: "770c5b8f-23c5-488c-b9ad-c8f718b7c1e1"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:11.361Z"
provenance:
    sourcePlans:
        - "44407264-433c-4ac6-93a3-6a3aa0a46f77"
---

# Consent-gated Pi code extensions

## Summary

RunWield recognizes, installs, persists, and loads Pi-shaped code extensions that explicitly declare RunWield compatibility. Installation requires clear user consent and defaults to denial in noninteractive flows. Passive themes and prompts remain available, while incompatible executable extensions are ignored.

## Future Planning Notes

Compatibility metadata is author self-attestation, not vetting or sandboxing. Extension API version changes need explicit compatibility and migration rules.
