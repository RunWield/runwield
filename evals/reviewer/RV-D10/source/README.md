# Repair publication

A local publication service sends a validated repair commit to a Git target branch. It integrates the fetched target,
uses an explicit force-with-lease expectation, and saves the attempt before sending. A rejected push remains pending
with its error for a later operator action. A successful push is recorded as published.

`publishValidated(workspace, attemptFile, request)` in `src/publication.ts` accepts a remote, a full branch ref, and a
validated commit ID. The repair workspace must be clean and exclusively owned by the service. Attempt files live
outside its working tree. Validation of the supplied candidate is the caller's responsibility.

Use Bun 1.4.3 and Git. Run `bun run test`. Tests create disposable local repositories outside this project. They do not
use the materialized project's Git history or global Git configuration.

The approved change is in [Resume saved publication attempts](docs/plans/resume-saved-publication.md).
