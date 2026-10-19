---
kind: "work_record"
recordId: "b007c18e-55c1-4897-a272-19e7d9aeadff"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-22T17:32:13.639Z"
provenance:
    sourcePlans:
        - "b587b9c5-cc2f-4cce-8564-93b6b86c2cd1"
---

# Guide Markdown document tools

## Summary

Guide can use `write_docs` and `edit_docs` for explicit user requests to preserve or update ordinary Markdown documentation without general file-mutation access. These tools do not extend to delegated Agents or change Router and Operator behavior.

## Future Planning Notes

The `.md` restriction is lexical, not a sandbox. Support for other document extensions requires a deliberate validator-policy change.
