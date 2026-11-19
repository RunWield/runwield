---
kind: "work_record"
recordId: "04ef5736-a942-4145-8542-b1aa8d7742b9"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-15T03:49:26.491Z"
provenance:
    sourcePlans:
        - "ad8b3586-b7e9-4b1e-b7fa-c132f48a3ad8"
---
# Ideator and Guide conversations in Connect

## Summary

RunWield Connect supports Ideator and Guide in Claude Code and Codex through Router routing and dedicated commands. Both entry paths load current layered role definitions and Skills, while the host owns the conversation and model calls. Ideator explores ideas and writes requested PRDs; Guide answers from project evidence and saves ordinary Markdown on request, without automatically starting planning or implementation. Codex applies explicit per-role model and thinking preferences through native controls and continues follow-ups with the same dispatched worker. Conversational entry preserves open delivery workflows and their normal resume behavior.

## Out of Scope

This work does not include additional hosts, a settings UI, a general Agent switcher, Core-owned conversation persistence or resume, or new Memory, image, or artifact-registration bridges.

## Future Planning Notes

Keep conversational instruction reads stateless. Router handoffs close only the routing record; they do not represent delivery completion or store the conversation, role prompts, or dispatch preferences. Start planning only on an explicit user request through a new normal Connect request, preserving Router, Plan review, and execution gates. Guide's instructions do not create a host permission sandbox. Requested document writes must not imply unavailable Core artifact registration or Memory persistence.
