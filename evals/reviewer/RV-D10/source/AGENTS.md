# Engineering policy

Publication owns attempt records and Git transitions. Keep these operations in the production service, not injectable
callbacks. Callers provide an exclusively owned repair workspace and an attempt-file path outside the working tree.
Do not change HOME or the process working directory. Git tests use real temporary bare remotes and workspaces outside
this project, explicit author and committer identity, and no global Git configuration. Remove them in `finally`.
Use Bun 1.4.3 and run `bun run test` before delivery.
