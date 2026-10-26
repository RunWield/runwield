---
kind: work_record
recordId: fb1d3b91-e3c7-4cb3-b216-4027e556d912
status: approved
scope: feature
origin: external
completionMode: verified
createdAt: 2026-07-14T08:32:00-04:00
provenance:
    evidence:
        - path: src/ui/workspace/pages/index.astro
          note: Composes the active Plan board and its integrated tab-toolbar search entry point.
        - path: src/ui/workspace/components/Board.jsx
          note: Defines the responsive lifecycle columns and contained Plan and Epic card layout.
        - path: src/ui/workspace/islands/PlanBoardDragDrop.jsx
          note: Implements lifecycle-aware card dragging, valid transitions, source ghosts, and invalid-drop return behavior.
        - path: src/ui/workspace/islands/PlanBodyEditor.jsx
          note: Provides the Plannotator-backed Plan body viewer and editable save/cancel workflow.
        - path: src/ui/workspace/server/astro-canonical-data.js
          note: Keeps direct dev-server body edits and lifecycle transitions in memory while preserving production persistence behavior.
---

# Workspace Plan UI

## Summary

Workspace Plan cards remain contained within responsive lifecycle columns, and search lives in the board tab toolbar. Drag-and-drop exposes valid lifecycle transitions and visibly returns rejected drops to their source ghost. Plan details use the Plannotator viewer and editor with RunWield controls and theme inheritance. Direct development-server edits remain in memory without writing Plan files.
