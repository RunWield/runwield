import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "../../shared/sqlite.ts";

import "./server/plan-adapter.ts";

import { type RemoteWorkspaceApp, createWorkspaceApp } from "./server.ts";

import { hashCapability, SHARED_SPACE_IDEMPOTENCY_HEADER } from "@runwield/plans/plan-server";
import { openRemoteDatabase } from "./server/remote-db.ts";
import {
    createRemoteWorkspaceAdapter,
    openRemoteWorkspaceAdapter,
    RemoteWorkspaceError,
    type CreateRemoteSharedSpaceInput,
} from "./server/remote-adapter.ts";
import { REMOTE_SCHEMA_V1_SQL, REMOTE_SCHEMA_V2_SQL, REMOTE_SCHEMA_VERSION } from "./server/remote-schema.ts";

import { jsonRequest, readJsonResponse } from "./workspace-test-helpers.ts";

function createSpaceRequest<Body>(body: Body, requestId: string = crypto.randomUUID()) {
    return new Request("http://localhost/api/spaces/replay", {
        method: "POST",
        headers: { "content-type": "application/json", [SHARED_SPACE_IDEMPOTENCY_HEADER]: requestId },
        body: JSON.stringify(body),
    });
}

test("remote Workspace mode isolates local Plan Board and local APIs", async () => {
    const app = createWorkspaceApp({ mode: "remote" }).handler();
    for (const path of [
        "/",
        "/api/plans",
        "/api/board",
        "/api/plans/plan-1/body",
        "/api/plans/plan-1/lifecycle-action",
    ]) {
        const method = path.includes("body") || path.includes("lifecycle") ? "POST" : "GET";
        const response = await app(new Request(`http://localhost${path}`, { method }));
        assertEquals(response.status, 404);
    }
});

test("remote Shared Space API enforces capabilities, ciphertext storage, lifecycle, and delete", async () => {
    const reviewerCapability = "reviewer-secret-capability";
    const maintainerCapability = "maintainer-secret-capability";
    const workspaceApp = createWorkspaceApp({ mode: "remote" }) as RemoteWorkspaceApp;
    const adapter = workspaceApp.adapter;
    const database = adapter.database;
    const app = workspaceApp.handler();
    try {
        const reviewerHash = await hashCapability(reviewerCapability);
        const maintainerHash = await hashCapability(maintainerCapability);
        const payload = {
            planId: "plan-1",
            initialRevision: { payloadCiphertext: "cipher:initial-plan-body" },
            capabilities: [
                { scope: "reviewer", capabilityHash: reviewerHash },
                { scope: "maintainer", capabilityHash: maintainerHash },
            ],
        };
        const requestId = crypto.randomUUID();
        const createResponse = await app(createSpaceRequest(payload, requestId));
        assertEquals(createResponse.status, 201);
        const created = await readJsonResponse(createResponse);
        const spaceId = created.spaceId;

        const missingBearer = await app(new Request(`http://localhost/api/spaces/${spaceId}`));
        assertEquals(missingBearer.status, 401);

        const reviewerRead = await app(
            new Request(`http://localhost/api/spaces/${spaceId}`, {
                headers: { authorization: `Bearer ${reviewerCapability}` },
            }),
        );
        assertEquals(reviewerRead.status, 200);
        assertEquals((await readJsonResponse(reviewerRead)).latestRevision, 1);

        const reviewerAppendRevision = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/revisions`,
                { payloadCiphertext: "cipher:revision-2", expectedRevision: 2 },
                reviewerCapability,
            ),
        );
        assertEquals(reviewerAppendRevision.status, 403);

        const conflict = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/revisions`,
                { payloadCiphertext: "cipher:revision-2", expectedRevision: 3 },
                maintainerCapability,
            ),
        );
        assertEquals(conflict.status, 409);

        const appendRevision = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/revisions`,
                { payloadCiphertext: "cipher:revision-2", expectedRevision: 2 },
                maintainerCapability,
            ),
        );
        assertEquals(appendRevision.status, 201);

        const revision = await app(
            new Request(`http://localhost/api/spaces/${spaceId}/revisions/2`, {
                headers: { authorization: `Bearer ${reviewerCapability}` },
            }),
        );
        assertEquals(revision.status, 200);
        assertEquals((await readJsonResponse(revision)).revision.payloadCiphertext, "cipher:revision-2");

        const appendComment = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/revisions/2/comments`,
                { ciphertext: "cipher:comment-body" },
                reviewerCapability,
            ),
        );
        assertEquals(appendComment.status, 201);
        const commentId = (await readJsonResponse(appendComment)).comment.id;

        const revisionOneComments = await app(
            new Request(`http://localhost/api/spaces/${spaceId}/revisions/1/comments`, {
                headers: { authorization: `Bearer ${reviewerCapability}` },
            }),
        );
        assertEquals((await readJsonResponse(revisionOneComments)).comments.length, 0);

        const resolveComment = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
                { action: "resolve" },
                reviewerCapability,
            ),
        );
        assertEquals(resolveComment.status, 200);
        assertEquals((await readJsonResponse(resolveComment)).comment.resolved, true);

        const reopenComment = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
                { action: "reopen" },
                reviewerCapability,
            ),
        );
        assertEquals(reopenComment.status, 200);
        assertEquals((await readJsonResponse(reopenComment)).comment.resolved, false);

        const closeResponse = await app(
            jsonRequest(`http://localhost/api/spaces/${spaceId}/lifecycle`, { action: "close" }, maintainerCapability),
        );
        assertEquals(closeResponse.status, 200);
        assertEquals((await readJsonResponse(closeResponse)).status, "closed");

        const closedComment = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/revisions/2/comments`,
                { ciphertext: "cipher:late-comment" },
                reviewerCapability,
            ),
        );
        assertEquals(closedComment.status, 409);
        const closedState = await app(
            jsonRequest(
                `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
                { action: "resolve" },
                reviewerCapability,
            ),
        );
        assertEquals(closedState.status, 409);

        const rows = database.handle
            .prepare(
                "SELECT payload_ciphertext AS value FROM space_revisions UNION ALL SELECT ciphertext AS value FROM space_comments UNION ALL SELECT capability_hash AS value FROM space_capabilities",
            )
            .all();
        const storedText = JSON.stringify(rows);
        assertEquals(storedText.includes("reviewer-secret-capability"), false);
        assertEquals(storedText.includes("maintainer-secret-capability"), false);

        const invalidPlaintext = await app(
            createSpaceRequest({
                planId: "plan-2",
                body: "plaintext plan body",
                initialRevision: { payloadCiphertext: "cipher:plan" },
                capabilities: [
                    { scope: "reviewer", capabilityHash: reviewerHash },
                    { scope: "maintainer", capabilityHash: maintainerHash },
                ],
            }),
        );
        assertEquals(invalidPlaintext.status, 400);

        const reviewerDelete = await app(
            jsonRequest(`http://localhost/api/spaces/${spaceId}/lifecycle`, { action: "delete" }, reviewerCapability),
        );
        assertEquals(reviewerDelete.status, 403);

        const deleteResponse = await app(
            jsonRequest(`http://localhost/api/spaces/${spaceId}/lifecycle`, { action: "delete" }, maintainerCapability),
        );
        assertEquals(deleteResponse.status, 200);

        const deletedRead = await app(
            new Request(`http://localhost/api/spaces/${spaceId}`, {
                headers: { authorization: `Bearer ${maintainerCapability}` },
            }),
        );
        assertEquals(deletedRead.status, 404);

        const replay = await app(createSpaceRequest(payload, requestId));
        assertEquals(replay.status, 410);
        assertEquals((await readJsonResponse(replay)).error, "shared_space_gone");
        assertEquals(database.handle.prepare("SELECT * FROM share_attempts").all(), [
            { id: requestId, space_id: null },
        ]);
        for (const table of ["shared_spaces", "space_revisions", "space_comments", "space_capabilities"]) {
            assertEquals(database.handle.prepare(`SELECT * FROM ${table}`).all(), []);
        }

        const sharedAgain = await app(createSpaceRequest(payload));
        assertEquals(sharedAgain.status, 201);
        assertEquals((await readJsonResponse(sharedAgain)).spaceId === spaceId, false);
        const delayedReplay = await app(createSpaceRequest(payload, requestId));
        assertEquals(delayedReplay.status, 410);
    } finally {
        adapter.close();
    }
});

test("only the current Shared Space creation protocol can create a space", async () => {
    const workspaceApp = createWorkspaceApp({ mode: "remote" }) as RemoteWorkspaceApp;
    const adapter = workspaceApp.adapter;
    const app = workspaceApp.handler();
    const payload = {
        planId: "plan-1",
        initialRevision: { payloadCiphertext: "cipher:plan" },
        capabilities: [
            { scope: "reviewer", capabilityHash: "reviewer-hash" },
            { scope: "maintainer", capabilityHash: "maintainer-hash" },
        ],
    };
    try {
        const legacy = await app(jsonRequest("http://localhost/api/spaces", payload));
        assertEquals(legacy.status, 400);
        assertEquals((await readJsonResponse(legacy)).error, "share_protocol_required");

        const missing = await app(jsonRequest("http://localhost/api/spaces/replay", payload));
        assertEquals(missing.status, 400);
        assertEquals((await readJsonResponse(missing)).error, "invalid_share_request_id");
        for (const id of ["plan-1", "00000000-0000-0000-0000-000000000000"]) {
            const invalid = await app(createSpaceRequest(payload, id));
            assertEquals(invalid.status, 400);
            assertEquals((await readJsonResponse(invalid)).error, "invalid_share_request_id");
        }
        assertEquals(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);
        assertEquals(adapter.database.handle.prepare("SELECT id FROM share_attempts").all(), []);
    } finally {
        adapter.close();
    }
});

test("remote requests over configured JSON body limit are rejected before writes", async () => {
    const workspaceApp = createWorkspaceApp({ mode: "remote", maxRequestBytes: 64 }) as RemoteWorkspaceApp;
    const adapter = workspaceApp.adapter;
    const database = adapter.database;
    const app = workspaceApp.handler();
    try {
        const response = await app(
            new Request("http://localhost/api/spaces/replay", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": "65",
                    [SHARED_SPACE_IDEMPOTENCY_HEADER]: crypto.randomUUID(),
                },
                body: JSON.stringify({ planId: "too-large" }),
            }),
        );
        assertEquals(response.status, 413);
        assertEquals((await readJsonResponse(response)).error, "request_too_large");
        const streamed = await app(
            new Request("http://localhost/api/spaces/replay", {
                method: "POST",
                headers: { "content-type": "application/json", [SHARED_SPACE_IDEMPOTENCY_HEADER]: crypto.randomUUID() },
                body: JSON.stringify({ planId: "too-large", filler: "x".repeat(128) }),
            }),
        );
        assertEquals(streamed.status, 413);
        const count = database.handle.prepare("SELECT COUNT(*) AS count FROM shared_spaces").get()!;
        assertEquals(Number(count.count), 0);
    } finally {
        adapter.close();
    }
});

test("a Shared Space creation request is bound to its exact encrypted payload across server restarts", () => {
    const directory = fsMkdtempSync(join(tmpdir(), "runwield-remote-replay-"));
    const dbPath = join(directory, "remote.sqlite");
    const input: CreateRemoteSharedSpaceInput = {
        planId: "replayed-plan",
        payloadCiphertext: "cipher:original",
        capabilities: [
            { scope: "reviewer", capabilityHash: "reviewer-hash" },
            { scope: "maintainer", capabilityHash: "maintainer-hash" },
        ],
    };
    const requestId = crypto.randomUUID();
    let adapter = openRemoteWorkspaceAdapter({ dbPath });
    try {
        const created = adapter.createSharedSpace(input, requestId);
        adapter.appendRevision(created.spaceId, "cipher:revision-two");
        adapter.closeSharedSpace(created.spaceId);
        adapter.close();
        adapter = openRemoteWorkspaceAdapter({ dbPath });
        assertEquals(adapter.createSharedSpace(input, requestId), created);
        assertEquals(adapter.getSharedSpace(created.spaceId).status, "closed");
        assertEquals(adapter.getSharedSpace(created.spaceId).latestRevision, 2);
        assertThrows(
            () => adapter.createSharedSpace({ ...input, payloadCiphertext: "cipher:different" }, requestId),
            RemoteWorkspaceError,
            "does not match",
        );
        for (const scope of ["reviewer", "maintainer"]) {
            const capabilities = input.capabilities.map((entry) =>
                entry.scope === scope ? { ...entry, capabilityHash: "substituted-hash" } : entry,
            );
            assertThrows(
                () => adapter.createSharedSpace({ ...input, capabilities }, requestId),
                RemoteWorkspaceError,
                "does not match",
            );
        }
        assertThrows(
            () => adapter.createSharedSpace({ ...input, planId: "other-plan" }, requestId),
            RemoteWorkspaceError,
            "does not match",
        );
        assertEquals(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all().length, 1);

        adapter.deleteSharedSpace(created.spaceId);
        adapter.close();
        adapter = openRemoteWorkspaceAdapter({ dbPath });
        const gone = assertThrows(
            () => adapter.createSharedSpace(input, requestId),
            RemoteWorkspaceError,
            "was deleted or expired",
        );
        assertEquals(gone.status, 410);
        assertEquals(gone.code, "shared_space_gone");
        assertEquals(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);
        assertEquals(adapter.database.handle.prepare("SELECT * FROM share_attempts").all(), [
            { id: requestId, space_id: null },
        ]);
    } finally {
        adapter.close();
        fsRmSync(directory, { recursive: true });
    }
});

test("remote retention refreshes on writes and cleanup hard-deletes expired Shared Spaces", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const database = openRemoteDatabase();
    const adapter = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    try {
        const reviewerCapability = "reviewer-retention";
        const maintainerCapability = "maintainer-retention";
        const input: CreateRemoteSharedSpaceInput = {
            planId: "retention-plan",
            payloadCiphertext: "cipher:plan",
            capabilities: [
                { scope: "reviewer", capabilityHash: await hashCapability(reviewerCapability) },
                { scope: "maintainer", capabilityHash: await hashCapability(maintainerCapability) },
            ],
        };
        const requestId = crypto.randomUUID();
        const created = adapter.createSharedSpace(input, requestId);
        assertEquals(created.expiresAt, "2026-01-08T00:00:00.000Z");

        now = new Date("2026-01-02T00:00:00.000Z");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-08T00:00:00.000Z");
        assertEquals(adapter.listRevisions(created.spaceId).length, 1);
        assertEquals(adapter.getRevision(created.spaceId, 1).createdAt, "2026-01-01T00:00:00.000Z");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-08T00:00:00.000Z");

        adapter.appendRevision(created.spaceId, "cipher:plan-2");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-09T00:00:00.000Z");

        now = new Date("2026-01-03T00:00:00.000Z");
        const comment = adapter.appendComment(created.spaceId, 2, "cipher:comment");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-10T00:00:00.000Z");

        now = new Date("2026-01-03T12:00:00.000Z");
        assertEquals(adapter.listComments(created.spaceId, 2).length, 1);
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-10T00:00:00.000Z");

        now = new Date("2026-01-04T00:00:00.000Z");
        adapter.setCommentState(created.spaceId, comment.id, "resolve");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-11T00:00:00.000Z");

        now = new Date("2026-01-05T00:00:00.000Z");
        adapter.setCommentState(created.spaceId, comment.id, "reopen");
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-12T00:00:00.000Z");

        now = new Date("2026-01-06T00:00:00.000Z");
        adapter.closeSharedSpace(created.spaceId);
        assertEquals(adapter.getSharedSpace(created.spaceId).expiresAt, "2026-01-13T00:00:00.000Z");

        now = new Date("2026-01-14T00:00:00.000Z");
        assertEquals(adapter.cleanupExpiredSharedSpaces(), 1);
        assertThrows(() => adapter.getSharedSpace(created.spaceId), RemoteWorkspaceError, "not found");
        assertEquals(assertThrows(() => adapter.createSharedSpace(input, requestId), RemoteWorkspaceError).status, 410);
        assertEquals(database.handle.prepare("SELECT * FROM share_attempts").all(), [
            { id: requestId, space_id: null },
        ]);
    } finally {
        adapter.close();
    }
});

test("replaying an expired creation before scheduled cleanup deletes it and retains its request ID", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const database = openRemoteDatabase();
    const adapter = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    const input: CreateRemoteSharedSpaceInput = {
        planId: "retention-plan",
        payloadCiphertext: "cipher:plan",
        capabilities: [
            { scope: "reviewer", capabilityHash: "reviewer-hash" },
            { scope: "maintainer", capabilityHash: "maintainer-hash" },
        ],
    };
    const requestId = crypto.randomUUID();
    try {
        const created = adapter.createSharedSpace(input, requestId);
        now = new Date("2026-01-07T23:59:59.999Z");
        assertEquals(adapter.createSharedSpace(input, requestId), created);

        now = new Date("2026-01-08T00:00:00.000Z");
        for (const payload of [input, { ...input, planId: "other-plan" }]) {
            const gone = assertThrows(() => adapter.createSharedSpace(payload, requestId), RemoteWorkspaceError);
            assertEquals(gone.status, 410);
            assertEquals(gone.code, "shared_space_gone");
        }
        assertEquals(database.handle.prepare("SELECT * FROM share_attempts").all(), [
            { id: requestId, space_id: null },
        ]);
        assertEquals(adapter.cleanupExpiredSharedSpaces(), 0);
        assertThrows(() => adapter.getSharedSpace(created.spaceId), RemoteWorkspaceError, "not found");
    } finally {
        adapter.close();
    }
});

test("remote retention cleanup removes expired Shared Spaces across bounded batches", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const database = openRemoteDatabase();
    const adapter = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    try {
        const insertSpace = database.handle.prepare(
            "INSERT INTO shared_spaces(id, plan_id, status, latest_revision, created_at, updated_at, expires_at) VALUES (?, ?, 'open', 1, ?, ?, ?)",
        );
        const insertRevision = database.handle.prepare(
            "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, 1, ?, ?)",
        );
        for (let index = 0; index < 205; index += 1) {
            const spaceId = `expired-${index}`;
            insertSpace.run(
                spaceId,
                `plan-${index}`,
                "2026-01-01T00:00:00.000Z",
                "2026-01-01T00:00:00.000Z",
                "2026-01-08T00:00:00.000Z",
            );
            insertRevision.run(spaceId, "cipher:plan", "2026-01-01T00:00:00.000Z");
        }
        insertSpace.run(
            "active-space",
            "active-plan",
            "2026-01-10T00:00:00.000Z",
            "2026-01-10T00:00:00.000Z",
            "2026-01-17T00:00:00.000Z",
        );
        insertRevision.run("active-space", "cipher:plan", "2026-01-10T00:00:00.000Z");

        assertEquals(adapter.cleanupExpiredSharedSpaces(), 205);
        const count = database.handle.prepare("SELECT COUNT(*) AS count FROM shared_spaces").get()!;
        assertEquals(Number(count.count), 1);
        assertEquals(adapter.getSharedSpace("active-space").spaceId, "active-space");
    } finally {
        adapter.close();
    }
});

test("remote retention reconciliation grants grace and disabling clears expiry", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const database = openRemoteDatabase();
    const noRetention = createRemoteWorkspaceAdapter({ database, clock: { now: () => now } });
    const created = noRetention.createSharedSpace(
        {
            planId: "grace-plan",
            payloadCiphertext: "cipher:plan",
            capabilities: [
                { scope: "reviewer", capabilityHash: await hashCapability("reviewer-grace") },
                { scope: "maintainer", capabilityHash: await hashCapability("maintainer-grace") },
            ],
        },
        crypto.randomUUID(),
    );
    assertEquals(created.expiresAt, undefined);

    const enabled = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    enabled.reconcileRetentionPolicy();
    assertEquals(enabled.getSharedSpace(created.spaceId).expiresAt, "2026-02-08T00:00:00.000Z");

    const disabled = createRemoteWorkspaceAdapter({ database, clock: { now: () => now } });
    disabled.reconcileRetentionPolicy();
    assertEquals(disabled.getSharedSpace(created.spaceId).expiresAt, undefined);
    disabled.close();
});

test("remote schema migration preserves shipped v2 spaces and their existing API links", async () => {
    const cwd = fsMkdtempSync(join(tmpdir(), "runwield-fixture-"));
    const reviewer = "reviewer-v2";
    const maintainer = "maintainer-v2";
    const reviewerHash = await hashCapability(reviewer);
    const maintainerHash = await hashCapability(maintainer);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-02T00:00:00.000Z";
    const expiresAt = "2026-01-09T00:00:00.000Z";
    try {
        const dbPath = `${cwd}/remote.sqlite`;
        const fixture = new DatabaseSync(dbPath);
        fixture.exec("PRAGMA foreign_keys = ON");
        fixture.exec(REMOTE_SCHEMA_V1_SQL);
        fixture.exec(REMOTE_SCHEMA_V2_SQL);
        fixture
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?), (2, ?)")
            .run(createdAt, updatedAt);
        fixture
            .prepare(
                "INSERT INTO shared_spaces(id, plan_id, status, latest_revision, created_at, updated_at, expires_at) VALUES (?, ?, 'open', 2, ?, ?, ?)",
            )
            .run("space-v2", "plan-v2", createdAt, updatedAt, expiresAt);
        fixture
            .prepare(
                "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, ?, ?, ?)",
            )
            .run("space-v2", 1, "cipher:revision-1", createdAt);
        fixture
            .prepare(
                "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, ?, ?, ?)",
            )
            .run("space-v2", 2, "cipher:revision-2", updatedAt);
        fixture
            .prepare(
                "INSERT INTO space_comments(id, space_id, revision, ciphertext, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
            )
            .run(
                "comment-v2",
                "space-v2",
                1,
                "cipher:comment-v2",
                "2026-01-01T12:00:00.000Z",
                "2026-01-01T13:00:00.000Z",
            );
        fixture
            .prepare("INSERT INTO space_capabilities(space_id, scope, capability_hash, created_at) VALUES (?, ?, ?, ?)")
            .run("space-v2", "reviewer", reviewerHash, createdAt);
        fixture
            .prepare("INSERT INTO space_capabilities(space_id, scope, capability_hash, created_at) VALUES (?, ?, ?, ?)")
            .run("space-v2", "maintainer", maintainerHash, createdAt);
        fixture.close();

        const workspaceApp = createWorkspaceApp({ mode: "remote", dbPath }) as RemoteWorkspaceApp;
        const app = workspaceApp.handler();
        const database = workspaceApp.adapter.database.handle;
        const base = "http://localhost/api/spaces/space-v2";
        const read = (url: string) => app(new Request(url, { headers: { authorization: `Bearer ${reviewer}` } }));
        try {
            assertEquals(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(), {
                version: REMOTE_SCHEMA_VERSION,
            });
            assertEquals(database.prepare("PRAGMA foreign_key_check").all(), []);
            assertEquals(database.prepare("SELECT id FROM share_attempts").all(), []);

            const space = await read(base);
            assertEquals(space.status, 200);
            const metadata = await readJsonResponse(space);
            assertEquals(metadata.latestRevision, 2);
            assertEquals(metadata.expiresAt, expiresAt);
            for (const number of [1, 2]) {
                const revision = await read(`${base}/revisions/${number}`);
                assertEquals(revision.status, 200);
                assertEquals(
                    (await readJsonResponse(revision)).revision.payloadCiphertext,
                    `cipher:revision-${number}`,
                );
            }
            const comments = await read(`${base}/revisions/1/comments`);
            assertEquals(comments.status, 200);
            const [comment] = (await readJsonResponse(comments)).comments;
            assertEquals(comment.ciphertext, "cipher:comment-v2");
            assertEquals(comment.resolved, true);

            const posted = await app(
                jsonRequest(`${base}/revisions/2/comments`, { ciphertext: "cipher:new-comment" }, reviewer),
            );
            assertEquals(posted.status, 201);
            const pushed = await app(
                jsonRequest(
                    `${base}/revisions`,
                    { payloadCiphertext: "cipher:revision-3", expectedRevision: 3 },
                    maintainer,
                ),
            );
            assertEquals(pushed.status, 201);
            const unshared = await app(jsonRequest(`${base}/lifecycle`, { action: "delete" }, maintainer));
            assertEquals(unshared.status, 200);
            assertEquals((await read(base)).status, 404);
            assertEquals(database.prepare("SELECT id FROM share_attempts").all(), []);

            database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(99, createdAt);
        } finally {
            workspaceApp.adapter.close();
        }

        assertThrows(() => openRemoteDatabase({ dbPath }), Error, "newer than supported");
    } finally {
        fsRmSync(cwd, { recursive: true });
    }
});
