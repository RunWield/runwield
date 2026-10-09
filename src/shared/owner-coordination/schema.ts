/*
 * @module shared/owner-coordination/schema
 * Owner-only coordination schema for registered Projects, paired devices, stable
 * Session cataloging, and Session activation state.
 */

export const OWNER_COORDINATION_SCHEMA_VERSION = 10;

export const OWNER_COORDINATION_SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    registered_root TEXT NOT NULL,
    current_root TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('enabled', 'disabled', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT,
    removed_at TEXT,
    restored_at TEXT,
    relinked_at TEXT
);

CREATE TABLE IF NOT EXISTS project_roots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    entered_root TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    root_state TEXT NOT NULL CHECK (root_state IN ('current', 'historical')),
    created_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    UNIQUE(project_id, entered_root)
);

CREATE TABLE IF NOT EXISTS runwield_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    display_name TEXT,
    source TEXT NOT NULL DEFAULT 'catalog' CHECK (source IN ('catalog', 'created', 'imported')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS session_transcript_locators (
    id TEXT PRIMARY KEY,
    runwield_session_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL UNIQUE,
    transcript_cwd TEXT NOT NULL,
    header_version INTEGER,
    header_timestamp TEXT,
    first_cataloged_at TEXT NOT NULL,
    last_cataloged_at TEXT NOT NULL,
    FOREIGN KEY (runwield_session_id) REFERENCES runwield_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    UNIQUE(project_id, pi_session_id)
);

CREATE TABLE IF NOT EXISTS project_session_catalog_scans (
    project_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    session_dir TEXT NOT NULL,
    last_scanned_dir_mtime_ms INTEGER,
    last_scanned_jsonl_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT NOT NULL,
    PRIMARY KEY (project_id, cwd),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_project_roots_project ON project_roots(project_id);
CREATE INDEX IF NOT EXISTS idx_project_roots_state ON project_roots(root_state);
CREATE INDEX IF NOT EXISTS idx_projects_lifecycle ON projects(lifecycle);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runwield_sessions_id_project ON runwield_sessions(id, project_id);
CREATE INDEX IF NOT EXISTS idx_runwield_sessions_project ON runwield_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_session_catalog_scans_project ON project_session_catalog_scans(project_id);
CREATE INDEX IF NOT EXISTS idx_session_transcript_locators_project ON session_transcript_locators(project_id);
CREATE INDEX IF NOT EXISTS idx_session_transcript_locators_pi ON session_transcript_locators(pi_session_id);
`;

export const OWNER_COORDINATION_SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS pairing_requests (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    proof_hash TEXT NOT NULL UNIQUE,
    device_label TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'claimed', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT,
    claimed_at TEXT,
    claimed_device_id TEXT,
    approval_attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (claimed_device_id) REFERENCES paired_devices(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pairing_requests_code_hash ON pairing_requests(code_hash);
CREATE INDEX IF NOT EXISTS idx_pairing_requests_state ON pairing_requests(state);
CREATE INDEX IF NOT EXISTS idx_pairing_requests_expires_at ON pairing_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_paired_devices_revoked ON paired_devices(revoked_at);
`;

export const OWNER_COORDINATION_SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS owner_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runwield_sessions_id_project ON runwield_sessions(id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_locators_id_project ON session_transcript_locators(runwield_session_id, project_id);

CREATE TABLE IF NOT EXISTS session_activation_state (
    runwield_session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('uninitialized', 'idle', 'active', 'uncertain', 'reconcile_required')),
    phase TEXT CHECK (phase IS NULL OR phase IN ('bootstrap', 'preparing', 'hydrated', 'turning', 'checkpointing')),
    latest_generation INTEGER CHECK (latest_generation IS NULL OR latest_generation >= 0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    owner_instance_id TEXT,
    owner_process_kind TEXT CHECK (owner_process_kind IS NULL OR owner_process_kind IN ('workspace', 'tui', 'acp', 'test')),
    operation_id TEXT,
    expected_generation INTEGER CHECK (expected_generation IS NULL OR expected_generation >= 0),
    acquired_at TEXT,
    heartbeat_at TEXT,
    heartbeat_deadline_at TEXT,
    updated_at TEXT NOT NULL,
    blocked_reason TEXT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    CHECK ((state = 'active') = (phase IS NOT NULL)),
    CHECK ((state = 'active') = (owner_instance_id IS NOT NULL AND owner_process_kind IS NOT NULL AND operation_id IS NOT NULL)),
    CHECK ((state = 'uninitialized') = (latest_generation IS NULL) OR (state <> 'uninitialized'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_activation_active_operation
    ON session_activation_state(owner_instance_id, operation_id)
    WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_session_activation_project ON session_activation_state(project_id);
CREATE INDEX IF NOT EXISTS idx_session_activation_state ON session_activation_state(state);

CREATE TABLE IF NOT EXISTS session_committed_generations (
    runwield_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    evidence_version INTEGER NOT NULL DEFAULT 1,
    digest_algorithm TEXT NOT NULL CHECK (digest_algorithm = 'sha256'),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    terminal_entry_id TEXT,
    digest_hex TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK (fence > 0),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (runwield_session_id, generation),
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    UNIQUE(runwield_session_id, project_id, generation)
);

CREATE TABLE IF NOT EXISTS owner_session_operations (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    runwield_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    expected_generation INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'continuation')),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'conflict')),
    operation_id TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    result_generation INTEGER,
    error_code TEXT,
    error_message TEXT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    UNIQUE(device_id, runwield_session_id, request_id)
);

INSERT OR IGNORE INTO session_activation_state(runwield_session_id, project_id, state, latest_generation, updated_at)
    SELECT id, project_id, 'uninitialized', NULL, COALESCE(updated_at, created_at)
      FROM runwield_sessions;

CREATE TRIGGER IF NOT EXISTS trg_runwield_sessions_activation_state
AFTER INSERT ON runwield_sessions
BEGIN
    INSERT OR IGNORE INTO session_activation_state(runwield_session_id, project_id, state, latest_generation, updated_at)
    VALUES (NEW.id, NEW.project_id, 'uninitialized', NULL, NEW.created_at);
END;
`;

export const OWNER_COORDINATION_SCHEMA_V4_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_runwield_sessions_id_project ON runwield_sessions(id, project_id);

CREATE TABLE session_transcript_locators_v4 (
    id TEXT PRIMARY KEY,
    runwield_session_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL UNIQUE,
    transcript_cwd TEXT NOT NULL,
    header_version INTEGER,
    header_timestamp TEXT,
    first_cataloged_at TEXT NOT NULL,
    last_cataloged_at TEXT NOT NULL,
    FOREIGN KEY (runwield_session_id) REFERENCES runwield_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    UNIQUE(project_id, pi_session_id)
);

INSERT INTO session_transcript_locators_v4(
    id,
    runwield_session_id,
    project_id,
    pi_session_id,
    transcript_path,
    transcript_cwd,
    header_version,
    header_timestamp,
    first_cataloged_at,
    last_cataloged_at
)
SELECT locators.id,
       locators.runwield_session_id,
       locators.project_id,
       locators.pi_session_id,
       locators.transcript_path,
       locators.transcript_cwd,
       locators.header_version,
       locators.header_timestamp,
       locators.first_cataloged_at,
       locators.last_cataloged_at
  FROM session_transcript_locators locators
  JOIN runwield_sessions sessions
    ON sessions.id = locators.runwield_session_id
   AND sessions.project_id = locators.project_id;

DROP TABLE session_transcript_locators;
ALTER TABLE session_transcript_locators_v4 RENAME TO session_transcript_locators;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_locators_id_project ON session_transcript_locators(runwield_session_id, project_id);
CREATE INDEX IF NOT EXISTS idx_session_transcript_locators_project ON session_transcript_locators(project_id);
CREATE INDEX IF NOT EXISTS idx_session_transcript_locators_pi ON session_transcript_locators(pi_session_id);
`;

export const OWNER_COORDINATION_SCHEMA_V5_SQL = `
DROP INDEX IF EXISTS idx_owner_session_operations_request;
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_session_operations_request
    ON owner_session_operations(COALESCE(device_id, '__owner_device_null__'), runwield_session_id, request_id);

CREATE TRIGGER IF NOT EXISTS trg_session_generations_append_only
BEFORE INSERT ON session_committed_generations
BEGIN
    SELECT CASE
        WHEN NEW.generation <> COALESCE((
            SELECT MAX(generation) + 1 FROM session_committed_generations
             WHERE runwield_session_id = NEW.runwield_session_id
        ), 0)
        THEN RAISE(ABORT, 'session generations must be append-only and monotonic')
    END;
    SELECT CASE
        WHEN NEW.terminal_entry_id IS NULL AND NEW.byte_length > (
            SELECT COALESCE(MIN(byte_length), NEW.byte_length)
              FROM session_committed_generations
             WHERE runwield_session_id = NEW.runwield_session_id
        )
        THEN RAISE(ABORT, 'terminal entry id is nullable only for header-only generations')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_generations_no_update
BEFORE UPDATE ON session_committed_generations
BEGIN
    SELECT RAISE(ABORT, 'session generations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_generations_no_delete
BEFORE DELETE ON session_committed_generations
BEGIN
    SELECT RAISE(ABORT, 'session generations are append-only');
END;
`;

export const OWNER_COORDINATION_SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS session_transcript_segments (
    id TEXT PRIMARY KEY,
    runwield_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL UNIQUE,
    transcript_cwd TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('planning', 'execution', 'semantic_repair')),
    sealed_at TEXT,
    header_version INTEGER,
    header_timestamp TEXT,
    first_cataloged_at TEXT NOT NULL,
    last_cataloged_at TEXT NOT NULL,
    lineage_parent_segment_id TEXT,
    lineage_parent_pi_session_id TEXT,
    lineage_group_key TEXT,
    lineage_recorded_at TEXT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    UNIQUE(runwield_session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS session_transcript_segment_state (
    runwield_session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    current_segment_id TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_segment_id) REFERENCES session_transcript_segments(id) ON DELETE RESTRICT
);

INSERT INTO session_transcript_segments(
    id,
    runwield_session_id,
    project_id,
    pi_session_id,
    transcript_path,
    transcript_cwd,
    ordinal,
    kind,
    sealed_at,
    header_version,
    header_timestamp,
    first_cataloged_at,
    last_cataloged_at
)
SELECT locators.id || '-segment-0',
       locators.runwield_session_id,
       locators.project_id,
       locators.pi_session_id,
       locators.transcript_path,
       locators.transcript_cwd,
       0,
       'planning',
       NULL,
       locators.header_version,
       locators.header_timestamp,
       locators.first_cataloged_at,
       locators.last_cataloged_at
  FROM session_transcript_locators locators;

INSERT OR IGNORE INTO session_transcript_segment_state(runwield_session_id, project_id, current_segment_id, updated_at)
SELECT sessions.id,
       sessions.project_id,
       segments.id,
       sessions.updated_at
  FROM runwield_sessions sessions
  LEFT JOIN session_transcript_segments segments
    ON segments.runwield_session_id = sessions.id
   AND segments.project_id = sessions.project_id
   AND segments.sealed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_segments_open
    ON session_transcript_segments(runwield_session_id)
    WHERE sealed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_segments_project ON session_transcript_segments(project_id);
CREATE INDEX IF NOT EXISTS idx_session_segments_pi ON session_transcript_segments(project_id, pi_session_id);
CREATE INDEX IF NOT EXISTS idx_session_segments_lineage_parent ON session_transcript_segments(lineage_parent_segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_state_project ON session_transcript_segment_state(project_id);

CREATE TRIGGER IF NOT EXISTS trg_session_segments_sealed_no_update
BEFORE UPDATE ON session_transcript_segments
WHEN OLD.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'sealed transcript segments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_segments_sealed_no_delete
BEFORE DELETE ON session_transcript_segments
WHEN OLD.sealed_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'sealed transcript segments are immutable');
END;

ALTER TABLE session_activation_state ADD COLUMN current_segment_id TEXT;
ALTER TABLE session_activation_state ADD COLUMN expected_current_segment_id TEXT;
ALTER TABLE session_committed_generations ADD COLUMN current_segment_id TEXT;

UPDATE session_activation_state
   SET current_segment_id = (
       SELECT current_segment_id
         FROM session_transcript_segment_state
        WHERE session_transcript_segment_state.runwield_session_id = session_activation_state.runwield_session_id
          AND session_transcript_segment_state.project_id = session_activation_state.project_id
   );

CREATE TRIGGER IF NOT EXISTS trg_runwield_sessions_segment_state
AFTER INSERT ON runwield_sessions
BEGIN
    INSERT OR IGNORE INTO session_transcript_segment_state(runwield_session_id, project_id, current_segment_id, updated_at)
    VALUES (NEW.id, NEW.project_id, NULL, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_session_segments_current_after_insert
AFTER INSERT ON session_transcript_segments
WHEN NEW.sealed_at IS NULL
BEGIN
    INSERT INTO session_transcript_segment_state(runwield_session_id, project_id, current_segment_id, updated_at)
    VALUES (NEW.runwield_session_id, NEW.project_id, NEW.id, NEW.last_cataloged_at)
    ON CONFLICT(runwield_session_id) DO UPDATE SET current_segment_id = NEW.id, updated_at = NEW.last_cataloged_at;
    UPDATE session_activation_state
       SET current_segment_id = NEW.id, updated_at = NEW.last_cataloged_at
     WHERE runwield_session_id = NEW.runwield_session_id
       AND project_id = NEW.project_id
       AND state <> 'active';
END;

CREATE TRIGGER IF NOT EXISTS trg_session_segments_current_after_seal
AFTER UPDATE OF sealed_at ON session_transcript_segments
WHEN NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL
BEGIN
    UPDATE session_transcript_segment_state
       SET current_segment_id = NULL, updated_at = NEW.sealed_at
     WHERE runwield_session_id = NEW.runwield_session_id
       AND current_segment_id = NEW.id;
    UPDATE session_activation_state
       SET current_segment_id = NULL, updated_at = NEW.sealed_at
     WHERE runwield_session_id = NEW.runwield_session_id
       AND project_id = NEW.project_id
       AND current_segment_id = NEW.id
       AND state <> 'active';
END;
`;

export const OWNER_COORDINATION_SCHEMA_V7_SQL = `
ALTER TABLE session_transcript_segments ADD COLUMN sealed_byte_length INTEGER CHECK (sealed_byte_length IS NULL OR sealed_byte_length >= 0);
ALTER TABLE session_transcript_segments ADD COLUMN sealed_digest_hex TEXT;
ALTER TABLE session_transcript_segments ADD COLUMN sealed_terminal_entry_id TEXT;

UPDATE session_committed_generations
   SET current_segment_id = (
       SELECT only_segments.id
         FROM session_transcript_segments only_segments
        WHERE only_segments.runwield_session_id = session_committed_generations.runwield_session_id
          AND only_segments.project_id = session_committed_generations.project_id
        GROUP BY only_segments.runwield_session_id, only_segments.project_id
       HAVING COUNT(*) = 1
   )
 WHERE current_segment_id IS NULL
   AND 1 = (
       SELECT COUNT(*)
         FROM session_transcript_segments count_segments
        WHERE count_segments.runwield_session_id = session_committed_generations.runwield_session_id
          AND count_segments.project_id = session_committed_generations.project_id
   );
`;

export const OWNER_COORDINATION_SCHEMA_V8_SQL = `
CREATE TABLE owner_session_operations_v8 (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    runwield_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    expected_generation INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'continuation', 'plan_action')),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'conflict')),
    operation_id TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    result_generation INTEGER,
    result_http_status INTEGER CHECK (result_http_status IS NULL OR (result_http_status >= 100 AND result_http_status <= 599)),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    FOREIGN KEY (runwield_session_id, project_id) REFERENCES runwield_sessions(id, project_id) ON DELETE RESTRICT,
    UNIQUE(device_id, runwield_session_id, request_id)
);

INSERT INTO owner_session_operations_v8(
    id, device_id, request_id, request_hash, runwield_session_id, project_id, expected_generation,
    kind, status, operation_id, started_at, updated_at, completed_at, result_generation, error_code, error_message
)
SELECT id, device_id, request_id, request_hash, runwield_session_id, project_id, expected_generation,
       kind, status, operation_id, started_at, updated_at, completed_at, result_generation, error_code, error_message
  FROM owner_session_operations;

DROP TABLE owner_session_operations;
ALTER TABLE owner_session_operations_v8 RENAME TO owner_session_operations;

CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_session_operations_request
    ON owner_session_operations(COALESCE(device_id, '__owner_device_null__'), runwield_session_id, request_id);
`;

// Workspace operation receipts refer to file-authoritative Sessions. They keep
// stable IDs for idempotency, but cannot have a foreign key to the retired
// SQLite Session catalog.
export const OWNER_COORDINATION_SCHEMA_V9_SQL = `
CREATE TABLE owner_session_operations_v9 (
    id TEXT PRIMARY KEY,
    device_id TEXT,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    runwield_session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    expected_generation INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'continuation', 'plan_action')),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'conflict')),
    operation_id TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    result_generation INTEGER,
    result_http_status INTEGER CHECK (result_http_status IS NULL OR (result_http_status >= 100 AND result_http_status <= 599)),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    UNIQUE(device_id, runwield_session_id, request_id)
);

INSERT INTO owner_session_operations_v9(
    id, device_id, request_id, request_hash, runwield_session_id, project_id, expected_generation,
    kind, status, operation_id, started_at, updated_at, completed_at, result_generation,
    result_http_status, result_json, error_code, error_message
)
SELECT id, device_id, request_id, request_hash, runwield_session_id, project_id, expected_generation,
       kind, status, operation_id, started_at, updated_at, completed_at, result_generation,
       result_http_status, result_json, error_code, error_message
  FROM owner_session_operations;

DROP TABLE owner_session_operations;
ALTER TABLE owner_session_operations_v9 RENAME TO owner_session_operations;

CREATE UNIQUE INDEX idx_owner_session_operations_request
    ON owner_session_operations(COALESCE(device_id, '__owner_device_null__'), runwield_session_id, request_id);
`;

// Preserve legacy evidence while registered; removing the registration also
// removes its retired SQLite catalog, never the file-authoritative Sessions.
export const OWNER_COORDINATION_SCHEMA_V10_SQL = `
DROP TRIGGER trg_session_generations_no_delete;
CREATE TRIGGER trg_session_generations_no_delete
BEFORE DELETE ON session_committed_generations
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND lifecycle <> 'removed')
BEGIN
    SELECT RAISE(ABORT, 'session generations are append-only');
END;

DROP TRIGGER trg_session_segments_sealed_no_delete;
CREATE TRIGGER trg_session_segments_sealed_no_delete
BEFORE DELETE ON session_transcript_segments
WHEN OLD.sealed_at IS NOT NULL
 AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND lifecycle <> 'removed')
BEGIN
    SELECT RAISE(ABORT, 'sealed transcript segments are immutable');
END;
`;
