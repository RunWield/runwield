---
kind: "work_record"
recordId: "abf7b3ec-fcb3-4f22-bba6-c47b7cf089c8"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-20T23:45:54.469Z"
provenance:
    sourcePlans:
        - "8fb4ad2b-4dc7-41c2-9e8b-d384485eaa58"
---

# Complete Session export and Gist sharing

## Summary

RunWield exports the complete committed Session across all transcript segments in order, with Session metadata, artifacts, and Plan Associations. `/export` produces lossless JSON or self-contained HTML with segment headings, expandable tool calls, and collapsed thinking, preserving the conversation across planning and execution. Requests for `.jsonl` fail with guidance to use `.json`. `/share` uploads both formats to one secret GitHub Gist and reports the Gist and HTML preview links.

## Out of Scope

This work does not include Workspace browser downloads or Shared Session Snapshots, separate in-memory transcripts from Delegated Agents, validation, or AI review, or Background Task output logs. Parent-recorded results remain part of the exported Session.

## Future Planning Notes

Export reads must remain non-mutating and use one committed Manifest snapshot, with raw entries and rendered events derived from the same verified segments. Missing or invalid segment evidence must fail the export rather than produce a partial copy. Core owns the data read; UI code owns HTML rendering. Treat transcript content as untrusted and escape it in HTML. Both formats retain thinking and full recorded tool output; anyone with the secret Gist link can read them. The preview depends on an external service, so sharing must also provide the Gist URL.
