---
kind: "work_record"
recordId: "ecf6e199-a29a-4302-a449-c2fb84232372"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:46:00.187Z"
provenance:
    sourcePlans:
        - "e45aedd3-f831-401a-8661-2df652dbb48e"
---

# Context-safe AI review for large diffs

## Summary

AI review keeps small diffs inline and represents large diffs with compact changed-file packets and bounded read-only exploration through review_diff. Reviewer errors or blank responses trigger retry or cancel handling rather than empty Engineer feedback.

## Out of Scope

This work does not bound the complete diff sent to Plannotator Code Review.

## Future Planning Notes

Keep transient Reviewer permissions minimal and bound diff exploration to protect model context.
