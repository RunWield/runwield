---
kind: "work_record"
recordId: "6e6b260d-6254-4cbe-bc6d-89ab9131da19"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:52:54.858Z"
provenance:
    sourcePlans:
        - "b4cfe540-2c86-47eb-8963-74788ecb6af0"
---

# Astro, React, and Plannotator Workspace architecture

## Summary

Workspace uses Astro SSR, React islands, Tailwind, and Radix-compatible RunWield primitives. Token-protected local launch, Plan APIs, board and detail workflows, lifecycle actions, body editing, conflict handling, and theme propagation remain intact. Workspace-hosted Plan Review and Code Review replace compiled Plannotator review servers behind the existing review-launcher contract.
