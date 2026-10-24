---
planId: configure-project-listing
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Configure remote project listing

## Request

The project browser should support the catalog service's cursor pages and a user-controlled archive filter.
Keep the network behind the existing required ProjectCatalog port.

## Approved steps

1. Read filterEnabled from settings. Default it to enabled when absent; explicit false disables the archive filter.
2. Collect every cursor page before presenting results. Empty item arrays can still have a next cursor; stop only when
   that cursor is absent. Refuse repeated cursors rather than looping forever.
3. Apply the configured filter after collection, preserving catalog order.
4. Cover the default setting and normal two-page traversal in public tests.

## Validation

Use deterministic catalog fixtures without network requests. Run the public suite.
