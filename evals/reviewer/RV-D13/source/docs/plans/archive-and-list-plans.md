---
planId: archive-and-list-plans
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Archive and list Plans

## Request

Add an archive command and a focused archived list for the local Plan catalog. This is a single-writer command-line
catalog. Existing active Plans remain available to the ordinary list command.

## Approved steps

1. Move the selected Plan file from plans/active to plans/archived.
2. Record the archive time as an ISO timestamp on that Plan. Preserve its id, title, and body.
3. Accept `list --archived-only` and return only archived Plans. An unfiltered list continues to include all Plans.

## Validation

Use real temporary catalog directories. Cover the move, archive time, and list behavior. Run the public tests.
