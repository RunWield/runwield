---
kind: work_record
recordId: 9de7c36c-77c0-483f-a50e-f7682e1e4d8e
status: approved
scope: feature
origin: external
completionMode: verified
createdAt: 2026-07-14T08:32:00-04:00
provenance:
    evidence:
        - path: src/ui/workspace/pages/dev/code-review.astro
          note: Supplies the multi-file fixture used to exercise the complete Code Review experience locally.
        - path: src/ui/workspace/react/CodeReviewSurface.tsx
          note: Implements the ordered file sidebar, accordion diff viewer, viewed state, navigation, annotations, and review actions.
        - path: src/ui/workspace/react/PlanReviewSettings.tsx
          note: Shares the focused RunWield-compatible settings surface with Code Review.
        - path: src/ui/workspace/react/remote-review-payload.js
          note: Builds feedback and approval payloads containing inline and global comments plus available annotated images.
---

# Code Review UI

## Summary

The Workspace Code Review surface matches the established Plannotator review model while retaining RunWield's header, design-system styling, theme bridge, and focused settings. A sidebar-ordered accordion supports file navigation and Viewed state; marking a file Viewed collapses it, and unchecking it reopens it without forcing a scroll. Inline and global annotations work throughout, and both feedback and approval deliver every current comment and available annotated image to the Agent.
