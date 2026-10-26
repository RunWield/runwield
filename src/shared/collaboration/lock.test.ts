import { test } from "node:test";
import { assertEquals, assertInstanceOf, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import {
    assertSharedPlanWriteAllowed,
    COLLABORATION_LOCK_BYPASS,
    COLLABORATION_STATE_REMOTE_CANONICAL,
    isCollaborationLockBypass,
    isSharedPlanLocked,
    normalizeCollaborationFrontMatter,
    SHARED_PLAN_LOCK_REPAIR,
    SharedPlanLockError,
    type CollaborationFrontMatter,
    type CollaborationWriteOptions,
} from "./lock.ts";

interface FixtureWriteOptions extends Omit<CollaborationWriteOptions, "collaborationLockBypass"> {
    collaborationLockBypass?: symbol | string;
}

interface FixtureFrontMatter extends Omit<CollaborationFrontMatter, "collaborationRevision"> {
    collaborationRevision?: number | string;
}

type FixtureWriteAssertion = (attrs?: CollaborationFrontMatter, options?: FixtureWriteOptions) => void;
type FixtureFrontMatterNormalizer = (attrs?: FixtureFrontMatter) => CollaborationFrontMatter;

const lockedAttrs: CollaborationFrontMatter = {
    collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
    collaborationServerUrl: "https://plans.example.test/base",
    collaborationSpaceId: "space-1",
    collaborationRevision: 2,
    collaborationBodyHash: "abc123",
    collaborationSyncedAt: "2026-07-04T00:00:00.000Z",
};

test("shared plan lock detects only remote-canonical state", () => {
    assertEquals(isSharedPlanLocked(lockedAttrs), true);
    assertEquals(isSharedPlanLocked({ collaborationState: "local" }), false);
    assertEquals(isSharedPlanLocked({}), false);
});

test("shared plan lock fails closed for partial remote-canonical metadata", () => {
    const error = assertThrows(
        () => assertSharedPlanWriteAllowed({ collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL }),
        SharedPlanLockError,
    );
    assertStringIncludes(error.message, "remote-canonical");
    assertStringIncludes(error.message, "Repair collaboration metadata");
    assertStringIncludes(error.message, SHARED_PLAN_LOCK_REPAIR);
    assertStringIncludes(error.message, "wld plans pull");
    assertStringIncludes(error.message, "wld plans push");
    assertStringIncludes(error.message, "wld plans unshare");
});

test("shared plan lock accepts only exported exact bypass values", () => {
    assertSharedPlanWriteAllowed(lockedAttrs, { collaborationLockBypass: COLLABORATION_LOCK_BYPASS.pull });
    assertEquals(isCollaborationLockBypass(COLLABORATION_LOCK_BYPASS.push), true);
    assertEquals(isCollaborationLockBypass(true), false);
    assertThrows(
        () => (assertSharedPlanWriteAllowed as FixtureWriteAssertion)(lockedAttrs, { collaborationLockBypass: "pull" }),
        SharedPlanLockError,
    );
});

test("shared plan lock messages redact accidental URL fragments", () => {
    const error = assertThrows(
        () =>
            assertSharedPlanWriteAllowed({
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: "https://plans.example.test/#key=secret&cap=bearer",
                collaborationSpaceId: "space-1",
            }),
        SharedPlanLockError,
    );
    assertStringIncludes(error.message, "#[redacted]");
    assertEquals(error.message.includes("secret"), false);
    assertInstanceOf(error, SharedPlanLockError);
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
    assertEquals(attrs.collaborationServerUrl, "https://plans.example.test/base");
    assertEquals(attrs.collaborationSpaceId, "space-1");
    assertEquals(attrs.collaborationRevision, 3);
    assertEquals(attrs.collaborationBodyHash, "hash");
});

test("collaboration metadata omits invalid server URLs instead of preserving secret fragments", () => {
    const attrs = normalizeCollaborationFrontMatter({
        collaborationServerUrl: "https://plans.example.test/base#contentKey=secret",
        collaborationSpaceId: "space-1",
    });
    assertEquals(attrs.collaborationServerUrl, undefined);
    assertEquals(attrs.collaborationSpaceId, "space-1");
});
