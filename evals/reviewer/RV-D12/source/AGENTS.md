# Architectural policy

This project owns registry mutation, persistence, and lock acquisition. Keep those operations closed: no optional
dependency bags, substitutable write functions, or injected locks. Do not choose a fake or real implementation based
on whether a caller supplies a dependency. Test local state through real temporary registry directories and real locks.

CatalogPort is the required external network boundary. A deterministic catalog implementation is allowed in tests.
Clocks and subprocesses may also be external ports when needed. They do not make registry operations external.

Run `bun run test` and `bun run seams:check`. The seam baseline is zero. Fix new seams; do not relax the checker.
Use Bun 1.4.3. Do not change HOME or the process working directory.
