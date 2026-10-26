# Engineering policy

Keep persistent state changes inside the service. Ports are for external capabilities, not local storage or authorization.
Use real temporary directories for persistence tests. Do not change HOME or the working directory.
Use Bun 1.4.3 and run `bun run test` before delivery.
