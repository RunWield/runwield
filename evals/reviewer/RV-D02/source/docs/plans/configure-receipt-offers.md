---
planId: configure-receipt-offers
status: approved
classification: PLANNED_CHANGE
workKind: FEATURE
---

# Configure receipt offers

## Request

Some shops do not want loyalty promotions printed on receipts. Extend receipt-settings.json with an optional
boolean enabled field for the rewards footer. Existing shops keep the footer by default. Explicit false must disable
it, while true enables it. Invoice lines, shop labels, and totals do not change. Settings files are local,
operator-managed JSON; no network service is needed.

## Approved steps

1. Load the optional footer setting with the existing receipt settings.
2. Use the normalized setting when rendering a receipt.
3. Keep coverage for ordinary receipts and add a shop with explicitly enabled offers.

## Validation

Use Bun 1.4.3. Run `bun run test` against real temporary data and local HTTP servers where needed.
