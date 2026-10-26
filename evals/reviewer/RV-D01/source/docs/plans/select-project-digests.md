---
planId: select-project-digests
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Select projects for digest refresh

## Request

Operators need to refresh digests for selected projects without changing the rest of the catalog. Add an optional
list of project identities to the existing batch service. Omission means all projects; an explicit empty list means
none. Return the identities changed. Repeated identities must not repeat work. Refuse an unrecognized identity before
writing any digest. The local catalog has one writer at a time.

## Approved steps

1. Extend the digest batch entry point with the optional selection.
2. Preserve the existing default and the catalog's ordering in the result.
3. Cover a targeted refresh and a refused identity without changing unselected projects.

## Validation

Use Bun 1.4.3. Run `bun run test` against real temporary data and local HTTP servers where needed.
