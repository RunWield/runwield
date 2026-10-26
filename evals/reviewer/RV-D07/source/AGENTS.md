# Project rules

Validation commands own their subprocesses. A cancelled result means command activity has settled. Use real subprocesses in tests.

Use Bun 1.4.3 and `bun run test`. Do not change HOME or the process working directory.
