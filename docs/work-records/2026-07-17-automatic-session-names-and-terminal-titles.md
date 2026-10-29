---
kind: "work_record"
recordId: "22273507-4d84-465a-8893-7e04fe48f1a6"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:28.487Z"
provenance:
    sourcePlans:
        - "fcdc3cfb-4111-4ea4-bef2-9f29d0e0cf51"
---

# Automatic Session names and terminal titles

## Summary

Router provides automatic Session names, and terminal titles use Session names with project fallbacks. The Pi-compatible /name command persists manual names, and title updates cover new and resumed Sessions. Automatic naming preserves existing names; terminal titles are sanitized and applied best-effort.

## Future Planning Notes

Terminal title support depends on the terminal emulator, multiplexer, and shell integration.
