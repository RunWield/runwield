---
status: accepted
---

# Remote-Canonical Collaborative Shared Spaces

Collaborative Planning treats a shared Plan as a remote-canonical Shared Space
while it is shared, rather than as an immutable snapshot or a local-only Plan
mirror. The Astro/React Workspace has a remote SQLite-backed mode for
self-hosted collaboration, while local RunWield Plans enter a hard Shared Plan
Lock that blocks normal local mutation except through collaboration commands.

Access uses bearer capabilities instead of accounts: reviewer capabilities allow
encrypted review/comment/resolve flows, maintainer capabilities allow team
handoff, pull, push, close, and destructive unshare. Content encryption keys
remain separate from authorization tokens so the server stores only ciphertext
for Plan/comment semantic content plus minimal routing metadata and capability
hashes.

The packaged v1 deployment is self-hosted Podman/OCI + SQLite. This decision
owns the self-hosted protocol, CLI loop, and browser review surface.

## Sharing from the CLI and Desktop

The CLI and Desktop use the same Plan Server protocol. A user selects a server by its URL. Both clients can
share a Plan in a Project by its stable Plan ID. The server can be self-hosted or operated by RunWield.

The signed-out connection generates a content key for each share and issues the existing reviewer and maintainer
links. Future sign-in binds an account to a particular server. Its connection encrypts with the account key and
authorizes API requests with an access token. The authenticated server associates the share with that account.
The account key stays private to the account. The caller supplies neither a destination flag nor credentials to
the share operation.

A new share binds its server and credentials when it starts. A retry uses the same binding and encrypted request
even if the configured server or signed-in account has since changed. This keeps an interrupted operation from
publishing a second copy or publishing under a different account.

Creation requires a Plan Server that records a random request ID before confirming the share. Clients use the
request-ID endpoint for the first attempt and subsequent retries. This prevents a retry against an older server
from allocating another space. Older spaces remain accessible through their existing links.

On deletion or expiry, the server removes the space and its contents in the same transaction that clears the
request ID’s link to the space. The random ID alone lets the server return HTTP 410 if a delayed create arrives.
Starting a new share uses a fresh request ID.
