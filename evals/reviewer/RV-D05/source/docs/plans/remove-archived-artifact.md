---
planId: remove-archived-artifact
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Remove an archived artifact

## Request

Add a maintenance action that permanently deletes one archived artifact. The caller supplies the archive root and a
relative artifact path. Delete only a regular file beneath that root. Refuse the root itself and paths outside it.
Keep existing list and read actions available. The archive is a trusted local tree with one writer at a time.

## Approved steps

1. Add the removal action to the archive service and command entry point.
2. Return the removed relative path so the caller can update its listing.
3. Test nested artifact deletion and refusal to delete the archive directory.

## Validation

Run the public suite in real temporary directories.
