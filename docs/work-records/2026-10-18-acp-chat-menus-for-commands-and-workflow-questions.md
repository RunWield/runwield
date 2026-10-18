---
kind: "work_record"
recordId: "4539f59e-2074-4614-9e77-548b593621df"
status: "pending_verification"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-18T23:19:32.760Z"
provenance:
    sourcePlans:
        - "ed3d4357-895e-4968-ad80-1ae3cfea82f0"
supersedes:
    - "ffc792b8-5c03-4c7f-80d7-4b8bc215c410"
    - "d140df78-c3cc-43d8-a0c8-8f588a67a5e7"
---

# ACP chat menus for commands and workflow questions

## Summary

RunWield’s ACP adapter uses native forms when supported and chat messages otherwise for select, text, and approval questions. Commands such as `/load-plan`, `/agent`, and `/model` can continue through chat replies without a loopback question page. Commands and Agent turns share one live operation that stays active between replies and moves its interaction bindings when `/load-plan` adopts another Session. Menus accept a number, exact label, or exact option value; invalid replies repeat the menu instead of dispatching another command.

## Out of Scope

This work does not include menu paging or persistence of pending chat questions across process restarts.

## Future Planning Notes

Keep command policy in Core and interaction presentation in the ACP adapter. Native forms take priority; Plan, Code, and Artifact Reviews retain browser links, including the Artifact Review feedback question page. Preserve interview-specific Other-answer rules: menu cancellation must not turn `cancel` into a cancellation for text or interview questions. Cancellation must settle before ACP returns `cancelled`, and replies must target the expected interaction so a stale reply cannot answer the next question.
