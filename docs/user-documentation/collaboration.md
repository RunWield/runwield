# Self-Hosted Collaborative Planning

RunWield can share a Plan as an encrypted **Shared Space** so teammates can review and comment on it in a browser
without installing RunWield. You run your own Plan Server, then use `wld plans share`, `pull`, `push`, and `unshare`
with it.

This guide uses placeholder addresses such as `https://plans.example.com`; replace them with your own.

## Deployment profiles

### Private or VPN deployment

For a trusted LAN/VPN/private network, keep retention disabled and expose the service only to the network boundary you
control. The default Compose file binds the container to host loopback, so remote access still requires an intentional
proxy, SSH tunnel, VPN port forward, or equivalent network configuration.

### Accountless public deployment

The Plan Server has no user accounts and no password for creating Shared Spaces. Anyone who can reach `POST /api/spaces`
can attempt to create encrypted Shared Spaces. For an internet-facing instance, run the Plan Server behind Nginx or an
equivalent reverse proxy that owns public TLS, request-size limits, and per-IP rate limits. Enable optional inactivity
retention if you want abandoned public links to be removed automatically.

RunWield itself serves plain HTTP inside the deployment boundary. Do not mount certificates into the container or expect
it to terminate HTTPS.

## Run the Plan Server with Podman Compose

From the repository root:

```bash
podman compose -f compose.yml up -d
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

`/healthz` reports that the server is running. `/readyz` also checks that it can open its database.

The compose service publishes `127.0.0.1:8080:8080` by default and persists SQLite data in the
`runwield-plan-server-data` Podman volume at `/data/runwield-shared-spaces.sqlite` inside the container.

Useful environment variables:

| Variable                            | Default                               | Purpose                                                        |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `RUNWIELD_REMOTE_HOST`              | `0.0.0.0`                             | Bind host inside the container.                                |
| `RUNWIELD_REMOTE_PORT`              | `8080`                                | HTTP port inside the container.                                |
| `RUNWIELD_REMOTE_DB_PATH`           | `/data/runwield-shared-spaces.sqlite` | SQLite database path.                                          |
| `RUNWIELD_WORKSPACE_REMOTE_DB_PATH` | unset                                 | Backward-compatible alternate database path variable.          |
| `RUNWIELD_REMOTE_MAX_REQUEST_BYTES` | `5242880`                             | Maximum JSON request body size; keep proxy limits in sync.     |
| `RUNWIELD_REMOTE_RETENTION_DAYS`    | unset / `0`                           | Optional inactivity retention. Use `7` for public trial hosts. |

## Public URL and reverse proxy

The URL used by `wld plans share` must be the externally reachable Plan Server URL. For local testing that is usually:

```text
http://127.0.0.1:8080
```

For a team deployment, put the container behind a reverse proxy with TLS and use a public base URL such as:

```text
https://plans.example.com
```

Start from `docs/examples/runwield-plan-server.nginx.conf` if you use Nginx. Incorporate it into your own TLS server
block, set `server_name`, and keep `client_max_body_size` aligned with `RUNWIELD_REMOTE_MAX_REQUEST_BYTES`.

Reverse proxies must preserve `Authorization: Bearer ...` unchanged for browser and CLI API calls. Do **not** use
ordinary HTTP Basic Auth in front of the Plan Server unless you have separately designed and tested a configuration that
does not consume or replace the bearer `Authorization` header. Prefer VPN, mTLS, IP allow-lists, cookie-based SSO, or a
private network if you need additional instance-level access control.

Browser URL fragments such as `#key=...&cap=...` are not sent to the server by browsers, but the remote review client
reads the fragment and sends the bearer capability in an `Authorization` header for API calls. Configure proxy logs not
to record authorization headers.

## Request limits, rate limits, and retention

The Plan Server rejects JSON request bodies larger than `RUNWIELD_REMOTE_MAX_REQUEST_BYTES` with `413`. This protects
the app if the proxy is misconfigured. Your reverse proxy should enforce the same or smaller body limit so oversized
requests fail before reaching Deno.

The Nginx example applies a stricter rate limit to `POST /api/spaces` than to ordinary review traffic. Anyone can call
that endpoint, so on a public server, watch disk use and request rates.

Inactivity retention is optional:

- unset or `0`: Shared Spaces do not expire;
- positive integer: each Shared Space receives an `expiresAt` timestamp that is visible in `wld plans share`,
  `wld plans pull`, and the remote review page;
- new Revisions, comments, resolve/reopen, and close refresh expiry;
- reads and page reloads do not refresh expiry;
- cleanup hard-deletes expired ciphertext and capability hashes;
- expired links behave like deleted/not-found remotes, and local Plans stay locked until a maintainer uses
  `wld plans unshare <plan>` recovery.

When retention is enabled on an existing database, rows without expiry receive one full configured retention window at
startup. Disabling retention clears persisted expiry and stops cleanup.

## Configure the CLI Plan Server URL

`planServerUrl` is a non-secret setting containing only the normalized Plan Server base URL. It must not include
`/p/<space-id>`, query parameters, or a `#key=...` fragment.

Project setting example in `.wld/settings.json`:

```jsonc
{
    "planServerUrl": "https://plans.example.com"
}
```

Global setting example in `~/.wld/settings.json`:

```jsonc
{
    "planServerUrl": "http://127.0.0.1:8080"
}
```

For one command, pass `--plan-server` instead of editing settings:

```bash
wld plans share my-plan --plan-server http://127.0.0.1:8080
```

Pull, push, and unshare refuse a `--plan-server` override that does not match the Plan's stored
`collaborationServerUrl`, so a maintainer cannot accidentally mutate a different Plan Server.

## Collaboration workflow

1. Share an active local Plan:

   ```bash
   wld plans share my-plan
   ```

   RunWield encrypts the Plan payload, creates a remote Shared Space, writes non-secret collaboration metadata to the
   Plan Front Matter, stores secrets locally, and prints reviewer and maintainer URLs once. If retention is enabled, the
   command also prints the current expiry.

2. Send reviewer URLs to stakeholders. Reviewers open the browser page, enter a display name, add global or inline
   comments, and resolve/reopen comments as needed. Reviewer URLs can read, comment, resolve, and reopen; they cannot
   pull, push, close, or unshare from the CLI.

3. Pull feedback as a maintainer:

   ```bash
   wld plans pull my-plan
   # or, in another checkout:
   wld plans pull '<maintainer-url>' --to my-plan
   ```

   Pull decrypts the latest Revision and its comments locally, updates or creates a locked local Plan, reports current
   expiry when present, and launches Planner or Architect with decrypted review context for incorporation.

4. After accepting the local Plan revision, publish it:

   ```bash
   wld plans push my-plan
   ```

   Push encrypts the current local Plan body as the next remote Revision. The same reviewer link remains valid and can
   switch between Revisions; comments remain scoped to the Revision where they were created.

5. When review is intentionally over and the remote Shared Space should be removed:

   ```bash
   wld plans unshare my-plan
   ```

   Unshare is destructive and CLI-only in v1. It requires maintainer secrets, deletes the remote Shared Space, removes
   matching local collaboration secrets, and clears local Shared Plan Lock metadata. `--force` skips prompts but not
   authorization or safety checks.

## Privacy model

The Plan Server stores ciphertext for semantic content:

- Plan bodies and Plan metadata payloads intended for review.
- Comment bodies.
- Reviewer display names.
- Original/selected text and annotation anchor/context metadata.

Allowed plaintext server metadata is limited to routing and lifecycle data such as Shared Space ids, `planId`, status,
Revision numbers, timestamps, resolved flags, optional `expiresAt`, and capability hashes. Raw content keys, raw bearer
capabilities, maintainer URLs, reviewer URLs, and plaintext comments must not be stored in SQLite, Plan Front Matter,
normal settings, logs, docs, commits, or issue trackers.

Content keys live in the browser URL fragment and local secret stores. The fragment is not sent in HTTP requests. Bearer
capabilities authorize API requests and are stored on the server only as hashes.

Local collaboration secret stores are plaintext JSON files with restrictive file permissions where the platform allows
that. Treat the files and maintainer URLs like passwords.

## Backup, restore, and upgrades

SQLite runs with WAL for file-backed databases. For a repeatable cold backup, stop the service so SQLite checkpoints WAL
state, copy the whole volume directory with ownership preserved, then run a real SQLite integrity check against the
copied database before trusting the backup:

```bash
podman compose -f compose.yml stop runwield-plan-server
mkdir -p backups
backup_dir="backups/runwield-plan-server-data-$(date +%Y%m%d%H%M%S)"
podman run --rm \
  -v runwield-plan-server-data:/data:ro \
  -v "$PWD/backups:/backup" \
  busybox sh -c "mkdir -p /backup/$(basename "$backup_dir") && cp -a /data/. /backup/$(basename "$backup_dir")/"

sqlite3 "$backup_dir/runwield-shared-spaces.sqlite" 'PRAGMA integrity_check;'
podman compose -f compose.yml up -d
curl http://127.0.0.1:8080/readyz
```

`PRAGMA integrity_check;` must print exactly `ok`. Any other output indicates the copied database is not a known-good
backup; keep the service stopped if you are diagnosing a production incident, preserve the failed backup for analysis,
and restore from an older backup that passes the check.

To test or perform a cold restore, stop the service, replace the volume contents from a backup directory that already
passed `PRAGMA integrity_check;`, start the service, then verify both SQLite integrity and application readiness:

```bash
restore_dir="backups/runwield-plan-server-data-YYYYMMDDHHMMSS"
sqlite3 "$restore_dir/runwield-shared-spaces.sqlite" 'PRAGMA integrity_check;'

podman compose -f compose.yml stop runwield-plan-server
podman run --rm \
  -v runwield-plan-server-data:/data \
  -v "$PWD/$restore_dir:/restore:ro" \
  busybox sh -c 'rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; cp -a /restore/. /data/'

# Optional but recommended: copy the restored database out and verify the restored volume contents.
restored_check_dir="$(mktemp -d)"
podman run --rm \
  -v runwield-plan-server-data:/data:ro \
  -v "$restored_check_dir:/check" \
  busybox sh -c 'cp -a /data/. /check/'
sqlite3 "$restored_check_dir/runwield-shared-spaces.sqlite" 'PRAGMA integrity_check;'

podman compose -f compose.yml up -d
curl http://127.0.0.1:8080/readyz
```

Both integrity checks must print `ok`. `/readyz` then proves the Plan Server process can open the restored database, but
it is not a substitute for `PRAGMA integrity_check;`. Finish a restore drill by opening a known reviewer URL or pulling
a known maintainer URL so you know ciphertext rows, revisions, comments, and capability hashes survived the restore.

Before rebuilding or upgrading, take a backup and verify it with `PRAGMA integrity_check;`. Database migrations are
forward-only unless explicitly documented otherwise. Do not start an older image against a newer migrated database;
restore a compatible pre-upgrade database if you need to roll back.

Avoid these unsafe patterns:

- copying only `runwield-shared-spaces.sqlite` while the service is live and ignoring `-wal`/`-shm` files;
- storing the SQLite database on a shared NFS/network filesystem;
- running multiple Plan Server containers against the same SQLite file;
- treating the source-built local OCI image as a published, signed, multi-architecture release artifact.

## Secret storage

By default, maintainer secrets are stored in:

```text
~/.wld/collaboration-secrets.json
```

With `--project-secrets`, RunWield uses the machine-owned project-local file:

```text
.wld/internal/collaboration-secrets.json
```

The project-local secret store is covered by the managed `.wld/internal/` ignore rule. Anyone with a maintainer URL can
import maintainer capability material and then pull, push, or unshare the Shared Space.

## Recovery cases

- **Lost local secrets:** re-import them by running `wld plans pull '<maintainer-url>'`. A reviewer URL is not enough
  for maintainer actions.
- **Reviewer-only URL:** can review in the browser but cannot pull, push, or unshare. Ask a maintainer for a maintainer
  URL if you need CLI maintenance access.
- **Deleted or expired remote:** pull/push will report not found or deleted state and leave local Shared Plan Lock
  metadata in place. Run `wld plans unshare <plan>` and confirm the already-deleted cleanup path to clear local
  metadata/secrets.
- **Unavailable Plan Server or 5xx/network failure:** local Plans stay locked because RunWield cannot prove whether the
  remote is safe to detach. Retry when the server is reachable.
- **Wrong capability or wrong Plan Server:** commands fail without local cleanup. Check that you are using a maintainer
  URL and the Plan's stored Plan Server URL.
- **Out-of-band local edits while locked:** RunWield detects body-hash divergence and refuses silent overwrite. Pull or
  resolve recovery explicitly instead of editing remote-canonical Plans directly.
