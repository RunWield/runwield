# Engineering policy

Use stable identities for storage. Keep presentation labels separate from record identities.
Use real temporary directories in tests of local persistence. Do not change HOME or the working directory.
Ports are for external capabilities, such as networks and clocks. Keep local state changes owned by this project.
Run `bun run test` before delivery. Use Bun 1.4.3; execute standalone assertion tests through the package script.
