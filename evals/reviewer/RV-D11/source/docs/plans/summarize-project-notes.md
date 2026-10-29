---
planId: summarize-project-notes
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Project note summary

## Request

Add a summary operation for the active project so the command host can show the note count and titles without
loading the complete note bodies into its view.

## Approved steps

1. Add `projectSummary()` to the commands module.
2. Return the number of notes and their titles in storage order.
3. Keep explicit-root save and list operations unchanged. An empty project has an empty summary.

## Validation

Use public APIs and real temporary files. Run the public suite.
