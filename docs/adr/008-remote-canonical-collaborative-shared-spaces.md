---
status: accepted
---

# ADR-008: Remote-Canonical Collaborative Shared Spaces

Collaborative Planning treats a shared Plan as a remote-canonical Shared Space while it is shared, rather than as an
immutable snapshot or a local-only Plan mirror. The Astro/React Workspace has a remote SQLite-backed mode for
self-hosted collaboration, while local RunWield Plans enter a hard Shared Plan Lock that blocks normal local mutation
except through collaboration commands.

Access uses bearer capabilities instead of accounts: reviewer capabilities allow encrypted review/comment/resolve flows,
maintainer capabilities allow team handoff, pull, push, close, and destructive unshare. Content encryption keys remain
separate from authorization tokens so the server stores only ciphertext for Plan/comment semantic content plus minimal
routing metadata and capability hashes.

The packaged v1 deployment is self-hosted Podman/OCI + SQLite. This decision owns the self-hosted protocol, CLI loop,
and browser review surface.
