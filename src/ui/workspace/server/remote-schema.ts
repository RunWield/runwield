/** @module ui/workspace/server/remote-schema */

export const REMOTE_SCHEMA_VERSION = 3;

export const REMOTE_SCHEMA_V1_SQL: string = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_spaces (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
);

CREATE TABLE IF NOT EXISTS space_capabilities (
    space_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('reviewer', 'maintainer')),
    capability_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (space_id, scope),
    FOREIGN KEY (space_id) REFERENCES shared_spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_revisions (
    space_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (space_id, revision),
    FOREIGN KEY (space_id) REFERENCES shared_spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS space_comments (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    ciphertext TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (space_id, revision) REFERENCES space_revisions(space_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_revisions_space_revision ON space_revisions(space_id, revision);
CREATE INDEX IF NOT EXISTS idx_space_comments_space_revision ON space_comments(space_id, revision);
CREATE INDEX IF NOT EXISTS idx_space_comments_space_id ON space_comments(space_id);
CREATE INDEX IF NOT EXISTS idx_space_capabilities_hash ON space_capabilities(capability_hash);
`;

export const REMOTE_SCHEMA_V2_SQL: string = `
ALTER TABLE shared_spaces ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_shared_spaces_expires_at ON shared_spaces(expires_at);
`;

export const REMOTE_SCHEMA_V3_SQL: string = `
CREATE TABLE share_attempts (
    id TEXT NOT NULL PRIMARY KEY,
    space_id TEXT UNIQUE REFERENCES shared_spaces(id) ON DELETE SET NULL
);
`;
