import { test } from "node:test";
import { equal, match, throws } from "node:assert/strict";
import {
    COLLABORATION_STATE_REMOTE_CANONICAL,
    normalizeCollaborationFrontMatter,
    type CollaborationFrontMatter,
} from "./format/collaboration.ts";
import { assertSharedPlanWriteAllowed, SHARED_PLAN_LOCK_REPAIR, SharedPlanLockError } from "./collaboration-lock.ts";

interface FixtureFrontMatter extends Omit<CollaborationFrontMatter, "collaborationRevision"> {
    collaborationRevision?: number | string;
}

type FixtureFrontMatterNormalizer = (attrs?: FixtureFrontMatter) => CollaborationFrontMatter;

test("shared plan lock fails closed for partial remote-canonical metadata", () => {
    throws(
        () => assertSharedPlanWriteAllowed({ collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL }),
        (error: Error) => {
            equal(error instanceof SharedPlanLockError, true);
            match(error.message, /remote-canonical/);
            match(error.message, /Repair collaboration metadata/);
            equal(error.message.includes(SHARED_PLAN_LOCK_REPAIR), true);
            match(error.message, /wld plans pull/);
            match(error.message, /wld plans push/);
            match(error.message, /wld plans unshare/);
            return true;
        },
    );
});

test("shared plan lock messages redact accidental URL fragments", () => {
    throws(
        () =>
            assertSharedPlanWriteAllowed({
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: "https://plans.example.test/#key=secret&cap=bearer",
                collaborationSpaceId: "space-1",
            }),
        (error: Error) => {
            equal(error instanceof SharedPlanLockError, true);
            equal(error.message.includes("#[redacted]"), true);
            equal(error.message.includes("secret"), false);
            return true;
        },
    );
});

test("collaboration metadata normalizes non-secret front matter values", () => {
    const attrs = (normalizeCollaborationFrontMatter as FixtureFrontMatterNormalizer)({
        collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
        collaborationServerUrl: " https://plans.example.test/base/ ",
        collaborationSpaceId: " space-1 ",
        collaborationRevision: "3",
        collaborationBodyHash: " hash ",
        collaborationSyncedAt: " 2026-07-04T00:00:00.000Z ",
    });
    equal(attrs.collaborationServerUrl, "https://plans.example.test/base");
    equal(attrs.collaborationSpaceId, "space-1");
    equal(attrs.collaborationRevision, 3);
    equal(attrs.collaborationBodyHash, "hash");
});

test("collaboration metadata omits invalid server URLs instead of preserving secret fragments", () => {
    const attrs = normalizeCollaborationFrontMatter({
        collaborationServerUrl: "https://plans.example.test/base#contentKey=secret",
        collaborationSpaceId: "space-1",
    });
    equal(attrs.collaborationServerUrl, undefined);
    equal(attrs.collaborationSpaceId, "space-1");
});
