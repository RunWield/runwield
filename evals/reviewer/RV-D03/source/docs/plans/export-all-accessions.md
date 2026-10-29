---
planId: export-all-accessions
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Export all museum accessions

## Request

The registrar needs a complete TSV export from the accession API rather than only the first page. Traverse cursor
pages in API order. Filtering can produce an empty items array with a continuation cursor; that page is not the end
of the export. A missing nextCursor ends traversal. Cursor values are opaque, including the empty string. Refuse a
repeated cursor instead of hanging or reporting a partial export as complete. Keep existing TSV formatting and HTTP
error behavior.

## Approved steps

1. Collect accession records across pages before formatting the export.
2. Keep pagination state within one export and report a cursor cycle as an error.
3. Exercise multiple pages, terminal empty results, and repeated-cursor refusal with a local API server.

## Validation

Use Bun 1.4.3. Run `bun run test` against real temporary data and local HTTP servers where needed.
