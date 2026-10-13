import { assertEquals } from "../../testing/assertions.ts";
import { mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "../../shared/sqlite.ts";

import { workspaceMetadata as _workspaceMetadata } from "./server/plan-adapter.js";

import { createWorkspaceApp } from "./server.js";

import { hashCapability } from "../../shared/collaboration/capabilities.ts";
import { openRemoteDatabase } from "./server/remote-db.ts";
import { createRemoteWorkspaceAdapter } from "./server/remote-adapter.js";
import { REMOTE_SCHEMA_V1_SQL } from "./server/remote-schema.ts";

import { jsonRequest, readJsonResponse } from "./workspace-test-helpers.js";

test("remote Workspace mode isolates local Plan Board and local APIs", async () => {
    const app = createWorkspaceApp({ mode: "remote" }).handler();
    for (
        const path of ["/", "/api/plans", "/api/board", "/api/plans/plan-1/body", "/api/plans/plan-1/lifecycle-action"]
    ) {
        const method = path.includes("body") || path.includes("lifecycle") ? "POST" : "GET";
        const response = await app(new Request(`http://localhost${path}`, { method }));
        assertEquals(response.status, 404);
    }
});

test("remote Shared Space API enforces capabilities, ciphertext storage, lifecycle, and delete", async () => {
    const reviewerCapability = "reviewer-secret-capability";
    const maintainerCapability = "maintainer-secret-capability";
    const workspaceApp = createWorkspaceApp({ mode: "remote" });
    const adapter = workspaceApp.adapter;
    const database = adapter.database;
    const app = workspaceApp.handler();
    try {
        const reviewerHash = await hashCapability(reviewerCapability);
        const maintainerHash = await hashCapability(maintainerCapability);
        const createResponse = await app(jsonRequest("http://localhost/api/spaces", {
            planId: "plan-1",
            initialRevision: { payloadCiphertext: "cipher:initial-plan-body" },
            capabilities: [
                { scope: "reviewer", capabilityHash: reviewerHash },
                { scope: "maintainer", capabilityHash: maintainerHash },
            ],
        }));
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

        const reviewerAppendRevision = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/revisions`,
            { payloadCiphertext: "cipher:revision-2", expectedRevision: 2 },
            reviewerCapability,
        ));
        assertEquals(reviewerAppendRevision.status, 403);

        const conflict = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/revisions`,
            { payloadCiphertext: "cipher:revision-2", expectedRevision: 3 },
            maintainerCapability,
        ));
        assertEquals(conflict.status, 409);

        const appendRevision = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/revisions`,
            { payloadCiphertext: "cipher:revision-2", expectedRevision: 2 },
            maintainerCapability,
        ));
        assertEquals(appendRevision.status, 201);

        const revision = await app(
            new Request(`http://localhost/api/spaces/${spaceId}/revisions/2`, {
                headers: { authorization: `Bearer ${reviewerCapability}` },
            }),
        );
        assertEquals(revision.status, 200);
        assertEquals((await readJsonResponse(revision)).revision.payloadCiphertext, "cipher:revision-2");

        const appendComment = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/revisions/2/comments`,
            { ciphertext: "cipher:comment-body" },
            reviewerCapability,
        ));
        assertEquals(appendComment.status, 201);
        const commentId = (await readJsonResponse(appendComment)).comment.id;

        const revisionOneComments = await app(
            new Request(`http://localhost/api/spaces/${spaceId}/revisions/1/comments`, {
                headers: { authorization: `Bearer ${reviewerCapability}` },
            }),
        );
        assertEquals((await readJsonResponse(revisionOneComments)).comments.length, 0);

        const resolveComment = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
            { action: "resolve" },
            reviewerCapability,
        ));
        assertEquals(resolveComment.status, 200);
        assertEquals((await readJsonResponse(resolveComment)).comment.resolved, true);

        const reopenComment = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
            { action: "reopen" },
            reviewerCapability,
        ));
        assertEquals(reopenComment.status, 200);
        assertEquals((await readJsonResponse(reopenComment)).comment.resolved, false);

        const closeResponse = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/lifecycle`,
            { action: "close" },
            maintainerCapability,
        ));
        assertEquals(closeResponse.status, 200);
        assertEquals((await readJsonResponse(closeResponse)).status, "closed");

        const closedComment = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/revisions/2/comments`,
            { ciphertext: "cipher:late-comment" },
            reviewerCapability,
        ));
        assertEquals(closedComment.status, 409);
        const closedState = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/comments/${commentId}/state`,
            { action: "resolve" },
            reviewerCapability,
        ));
        assertEquals(closedState.status, 409);

        const rows = database.handle.prepare(
            "SELECT payload_ciphertext AS value FROM space_revisions UNION ALL SELECT ciphertext AS value FROM space_comments UNION ALL SELECT capability_hash AS value FROM space_capabilities",
        ).all();
        const storedText = JSON.stringify(rows);
        assertEquals(storedText.includes("reviewer-secret-capability"), false);
        assertEquals(storedText.includes("maintainer-secret-capability"), false);
        assertEquals(storedText.includes("plaintext plan body"), false);
        assertEquals(storedText.includes("Alice"), false);
        assertEquals(storedText.includes("original text"), false);

        const invalidPlaintext = await app(jsonRequest("http://localhost/api/spaces", {
            planId: "plan-2",
            body: "plaintext plan body",
            initialRevision: { payloadCiphertext: "cipher:plan" },
            capabilities: [
                { scope: "reviewer", capabilityHash: reviewerHash },
                { scope: "maintainer", capabilityHash: maintainerHash },
            ],
        }));
        assertEquals(invalidPlaintext.status, 400);

        const reviewerDelete = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/lifecycle`,
            { action: "delete" },
            reviewerCapability,
        ));
        assertEquals(reviewerDelete.status, 403);

        const deleteResponse = await app(jsonRequest(
            `http://localhost/api/spaces/${spaceId}/lifecycle`,
            { action: "delete" },
            maintainerCapability,
        ));
        assertEquals(deleteResponse.status, 200);

        const deletedRead = await app(
            new Request(`http://localhost/api/spaces/${spaceId}`, {
                headers: { authorization: `Bearer ${maintainerCapability}` },
            }),
        );
        assertEquals(deletedRead.status, 404);
    } finally {
        adapter.close();
    }
});

test("remote requests over configured JSON body limit are rejected before writes", async () => {
    const workspaceApp = createWorkspaceApp({ mode: "remote", maxRequestBytes: 64 });
    const adapter = workspaceApp.adapter;
    const database = adapter.database;
    const app = workspaceApp.handler();
    try {
        const response = await app(
            new Request("http://localhost/api/spaces", {
                method: "POST",
                headers: { "content-type": "application/json", "content-length": "65" },
                body: JSON.stringify({ planId: "too-large" }),
            }),
        );
        assertEquals(response.status, 413);
        assertEquals((await readJsonResponse(response)).error, "request_too_large");
        const streamed = await app(
            new Request("http://localhost/api/spaces", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ planId: "too-large", filler: "x".repeat(128) }),
            }),
        );
        assertEquals(streamed.status, 413);
        const count = /** @type {{ count: number }} */ (
            database.handle.prepare("SELECT COUNT(*) AS count FROM shared_spaces").get()
        );
        assertEquals(Number(count.count), 0);
    } finally {
        adapter.close();
    }
});

test("remote retention refreshes on writes and cleanup hard-deletes expired Shared Spaces", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const database = openRemoteDatabase();
    const adapter = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    try {
        const reviewerCapability = "reviewer-retention";
        const maintainerCapability = "maintainer-retention";
        const created = adapter.createSharedSpace({
            planId: "retention-plan",
            payloadCiphertext: "cipher:plan",
            capabilities: [
                { scope: "reviewer", capabilityHash: await hashCapability(reviewerCapability) },
                { scope: "maintainer", capabilityHash: await hashCapability(maintainerCapability) },
            ],
        });
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
        let failed = false;
        try {
            adapter.getSharedSpace(created.spaceId);
        } catch (error) {
            failed = error instanceof Error && error.message.includes("not found");
        }
        assertEquals(failed, true);
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
        const count = /** @type {{ count: number }} */ (
            database.handle.prepare("SELECT COUNT(*) AS count FROM shared_spaces").get()
        );
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
    const created = noRetention.createSharedSpace({
        planId: "grace-plan",
        payloadCiphertext: "cipher:plan",
        capabilities: [
            { scope: "reviewer", capabilityHash: await hashCapability("reviewer-grace") },
            { scope: "maintainer", capabilityHash: await hashCapability("maintainer-grace") },
        ],
    });
    assertEquals(created.expiresAt, undefined);

    const enabled = createRemoteWorkspaceAdapter({ database, retention: { days: 7 }, clock: { now: () => now } });
    enabled.reconcileRetentionPolicy();
    assertEquals(enabled.getSharedSpace(created.spaceId).expiresAt, "2026-02-08T00:00:00.000Z");

    const disabled = createRemoteWorkspaceAdapter({ database, clock: { now: () => now } });
    disabled.reconcileRetentionPolicy();
    assertEquals(disabled.getSharedSpace(created.spaceId).expiresAt, undefined);
    disabled.close();
});

test("remote schema migration preserves v1 rows and rejects newer schemas", () => {
    const cwd = fsMkdtempSync(join(tmpdir(), "runwield-fixture-"));
    try {
        const dbPath = `${cwd}/remote.sqlite`;
        const fixture = new DatabaseSync(dbPath);
        fixture.exec("PRAGMA foreign_keys = ON");
        fixture.exec(REMOTE_SCHEMA_V1_SQL);
        fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
            1,
            "2026-01-01T00:00:00.000Z",
        );
        fixture.prepare(
            "INSERT INTO shared_spaces(id, plan_id, status, latest_revision, created_at, updated_at) VALUES (?, ?, 'open', 2, ?, ?)",
        ).run("space-v1", "plan-v1", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
        fixture.prepare(
            "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, ?, ?, ?)",
        ).run("space-v1", 1, "cipher:revision-1", "2026-01-01T00:00:00.000Z");
        fixture.prepare(
            "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, ?, ?, ?)",
        ).run("space-v1", 2, "cipher:revision-2", "2026-01-02T00:00:00.000Z");
        fixture.prepare(
            "INSERT INTO space_comments(id, space_id, revision, ciphertext, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        ).run(
            "comment-v1",
            "space-v1",
            1,
            "cipher:comment-v1",
            "2026-01-01T12:00:00.000Z",
            "2026-01-01T13:00:00.000Z",
        );
        fixture.prepare(
            "INSERT INTO space_capabilities(space_id, scope, capability_hash, created_at) VALUES (?, ?, ?, ?)",
        ).run("space-v1", "reviewer", "sha256:reviewer-v1", "2026-01-01T00:00:00.000Z");
        fixture.prepare(
            "INSERT INTO space_capabilities(space_id, scope, capability_hash, created_at) VALUES (?, ?, ?, ?)",
        ).run("space-v1", "maintainer", "sha256:maintainer-v1", "2026-01-01T00:00:00.000Z");
        fixture.close();

        const migrated = openRemoteDatabase({ dbPath });
        const row = /** @type {{ expires_at: string | null, latest_revision: number }} */ (
            migrated.handle.prepare("SELECT expires_at, latest_revision FROM shared_spaces WHERE id = ?").get(
                "space-v1",
            )
        );
        assertEquals(row.expires_at, null);
        assertEquals(Number(row.latest_revision), 2);
        assertEquals(
            migrated.handle.prepare(
                "SELECT payload_ciphertext FROM space_revisions WHERE space_id = ? AND revision = 1",
            ).get("space-v1"),
            {
                payload_ciphertext: "cipher:revision-1",
            },
        );
        assertEquals(
            migrated.handle.prepare(
                "SELECT payload_ciphertext FROM space_revisions WHERE space_id = ? AND revision = 2",
            ).get("space-v1"),
            {
                payload_ciphertext: "cipher:revision-2",
            },
        );
        assertEquals(
            migrated.handle.prepare("SELECT ciphertext, resolved FROM space_comments WHERE id = ?").get("comment-v1"),
            {
                ciphertext: "cipher:comment-v1",
                resolved: 1,
            },
        );
        assertEquals(
            migrated.handle.prepare("SELECT capability_hash FROM space_capabilities WHERE space_id = ? AND scope = ?")
                .get("space-v1", "reviewer"),
            {
                capability_hash: "sha256:reviewer-v1",
            },
        );
        assertEquals(
            migrated.handle.prepare("SELECT capability_hash FROM space_capabilities WHERE space_id = ? AND scope = ?")
                .get("space-v1", "maintainer"),
            {
                capability_hash: "sha256:maintainer-v1",
            },
        );
        const version = /** @type {{ version: number }} */ (
            migrated.handle.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
        );
        assertEquals(Number(version.version), 2);
        migrated.handle.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
            99,
            "2026-01-01T00:00:00.000Z",
        );
        migrated.close();

        let failed = false;
        try {
            openRemoteDatabase({ dbPath });
        } catch (error) {
            failed = error instanceof Error && error.message.includes("newer than supported");
        }
        assertEquals(failed, true);
    } finally {
        fsRmSync(cwd, { recursive: true });
    }
});
