# Project rules

The validation controller owns repair consumption and validation transitions. The application completion listener routes general task events. Restart recovery derives progress from saved completion evidence. The host serializes service calls; each project has one active repair task. Lifecycle writes and evidence storage are project-owned machinery, not injectable ports.

Use Bun 1.4.3 and `bun run test`. Do not change HOME or the process working directory.
