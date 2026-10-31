# Project rules

The lifecycle layer owns Plan front matter. The author owns the Markdown body and can edit it while commands run. Metadata updates must retain author text. Plan storage and rollback are project-owned machinery, not injectable ports.

Use Bun 1.4.3 and `bun run test`. Do not change HOME or the process working directory.
