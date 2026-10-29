---
kind: "work_record"
recordId: "b21052d8-8fca-40c6-8732-2944d40dae61"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-10-26T13:40:46.590Z"
provenance:
    sourcePlans:
        - "1765fe4a-1520-4106-9f4c-3cd833a38c91"
---

# Workspace renderer reuse and bounded observation retention

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: this
was done before epic validation Workspace reuses one loaded page renderer across navigation while keeping page data
specific to each request. Settled operations retain compact results instead of live transcript, tool, and image
payloads. Observation streams encode snapshots on reader demand, so slow readers do not accumulate a full snapshot for
every event. Saved history, duplicate-request protection, pending interactions, and background work remain intact when
browser observers disconnect. These ownership boundaries remove three sources of accumulated server memory without
replacing the single-process Workspace or file-authoritative Session model.

## Out of Scope

This work does not include whole-history projection optimization, browser history virtualization, token-review
conversation cleanup, guide-job retention changes, dependency reductions, retry expiry, or an absolute active-payload or
process-memory limit.

## Future Planning Notes

Browser connections, operations, background tasks, and saved Sessions have separate lifetimes; observation cleanup must
not cancel work or delete history. Each observer may retain one queued encoded snapshot plus a dirty/version marker, not
repeated snapshots for blocked delivery. Compact retry metadata may grow with request count, and one active snapshot can
still be large; bounded queuing is not an absolute memory ceiling. Production renderer replacement requires a server
restart; do not restore per-request cache-busting imports or cache request-specific responses. Missing-build recovery
must remain retryable. Memory checks must distinguish retained heap, external buffers, and RSS, since object release
does not guarantee an immediate RSS decrease.
