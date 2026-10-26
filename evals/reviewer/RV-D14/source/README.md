# History retention

History records are stored in `history.json`. The caller provides the operation time, so retention is reproducible.
Pruning writes the retained history back to the same store.

Run `bun run test` with Bun 1.4.3. No installation or network access is required.
