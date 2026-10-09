import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME } from "./constants.js";
import { getWorktreeRegistryPath } from "./shared/worktree-registry.js";
import { readControllerRecord } from "./shared/workflow/controller-registry.ts";
import {
    archivePlan,
    archivePlansByStatus,
    clearPlanCollaborationMetadata,
    countChildPlanProgress,
    createPulledCollaborationPlan,
    deleteArchivedPlanUnit,
    ensurePlanIdentity,
    ensurePlansDir,
    findPlanById,
    findPlansByParent,
    getPlansDir,
    getStoredPlanPath,
    groupPlanHierarchy,
    hashPlanBody,
    injectFrontMatter,
    inspectPlanFileStrict,
    isChildFeaturePlan,
    isEpicPlan,
    listArchivedPlans,
    listPlanResources,
    listPlans,
    loadArchivedPlan,
    loadExternalPlan,
    loadPlan,
    loadPlanBodyById,
    loadPlanStrict,
    onboardExternalPlan,
    parsePlanFrontMatter,
    PLAN_FRONT_MATTER_KEY_ORDER,
    PLAN_FRONT_MATTER_KEYS,
    PlanFrontMatterParseError,
    resolvePlan,
    resolvePlanExecutionPolicy,
    resolveSiblingChildPlanDependencyStates,
    restoreArchivedPlan,
    saveChildFeaturePlans,
    savePlan,
    savePlanBodyById,
    splitPlanMarkdownBody,
    StalePlanWriteError,
    updateArchivedPlanFrontMatter,
    updatePlanCollaborationMetadata,
    updatePlanFrontMatter,
    updatePlanStatus,
    withPlanCatalogLock,
    withPlanLock,
} from "./plan-store.js";
import {
    COLLABORATION_LOCK_BYPASS,
    COLLABORATION_STATE_REMOTE_CANONICAL,
    SharedPlanLockError,
} from "./shared/collaboration/lock.js";

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
function testWithFs(name, fn) {
    Deno.test({ name, permissions: { read: true, write: true }, fn });
}

/** @param {string} path */
async function assertMissing(path) {
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
}

Deno.test("controller-only updates preserve a formatted validated Plan byte for byte", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "validated-plan-controller-" });
    try {
        const path = join(cwd, "docs/plans/p.md");
        await Deno.mkdir(join(cwd, "docs/plans"), { recursive: true });
        const markdown =
            '---\nplanId: "controller-only-plan"\nclassification: "PLANNED_CHANGE"\nstatus: "validated"\naffectedPaths:\n    - "src/example.ts"\ndependencies:\n    - "previous-plan"\ntargetBranch: "main"\n---\n# Already formatted\n';
        await Deno.writeTextFile(path, markdown);
        const plan = await loadPlan(cwd, "p");
        assert(plan);
        await updatePlanFrontMatter(cwd, "p", { validationCiAttempts: 1 }, plan.attrs, {
            expectedRevision: plan.revision,
            expectedControllerRevision: plan.controllerRevision,
        });
        assertEquals(await Deno.readTextFile(path), markdown);
        assertEquals((await loadPlan(cwd, "p"))?.attrs.validationCiAttempts, 1);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

/** @param {string} cwd @param {string} planName */
async function recordActiveAttempt(cwd, planName) {
    const registryPath = getWorktreeRegistryPath(cwd);
    await Deno.mkdir(dirname(registryPath), { recursive: true });
    await Deno.writeTextFile(
        registryPath,
        JSON.stringify({
            version: 2,
            entries: [{
                id: "attempt-one",
                planName,
                path: cwd,
                branch: "worktree/test",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit: "a".repeat(40),
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            }],
        }),
    );
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @param {Partial<import('./plan-store.js').PlanFrontMatter>} updates
 * @param {Partial<import('./plan-store.js').PlanFrontMatter>} [recoveryAttrs]
 * @param {import('./plan-store.js').PlanWriteOptions} [options]
 */
async function updatePlanFrontMatterForTest(cwd, planName, updates, recoveryAttrs = {}, options = {}) {
    const plan = await loadPlan(cwd, planName);
    return await updatePlanFrontMatter(cwd, planName, updates, recoveryAttrs, {
        ...options,
        expectedRevision: options.expectedRevision || plan?.revision,
    });
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @param {import('./plan-store.js').PlanFrontMatter['status']} status
 * @param {Partial<import('./plan-store.js').PlanFrontMatter>} [recoveryAttrs]
 * @param {import('./plan-store.js').PlanWriteOptions} [options]
 */
async function updatePlanStatusForTest(cwd, planName, status, recoveryAttrs = {}, options = {}) {
    const plan = await loadPlan(cwd, planName);
    return await updatePlanStatus(cwd, planName, status, recoveryAttrs, {
        ...options,
        expectedRevision: options.expectedRevision || plan?.revision,
    });
}

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {string} body
 * @param {string} expectedBodyHash
 */
async function savePlanBodyByIdForTest(cwd, planId, body, expectedBodyHash) {
    const resource = await findPlanById(cwd, planId);
    const plan = await loadPlan(cwd, resource.planName || resource.name);
    return await savePlanBodyById(cwd, planId, body, expectedBodyHash, { expectedRevision: plan?.revision });
}

Deno.test("getStoredPlanPath resolves canonical top-level and nested plan paths", () => {
    assertEquals(getStoredPlanPath("/project", "demo"), "/project/docs/plans/demo.md");
    assertEquals(getStoredPlanPath("/project", "demo.md"), "/project/docs/plans/demo.md");
    assertEquals(getStoredPlanPath("/project", "epic/child.md"), "/project/docs/plans/epic/child.md");
    // The canonical store path prefix normalizes to the same store-relative name.
    assertEquals(getStoredPlanPath("/project", "docs/plans/demo.md"), "/project/docs/plans/demo.md");
});

Deno.test("getStoredPlanPath rejects escaping or ambiguous plan names", () => {
    for (const name of ["", "/tmp/demo", "epic//child", "epic/./child", "epic/../child", "../demo"]) {
        assertThrows(() => getStoredPlanPath("/project", name));
    }
});

Deno.test("front matter key constants expose canonical planning metadata order", () => {
    assertEquals(PLAN_FRONT_MATTER_KEYS.planId, "planId");
    assertEquals(PLAN_FRONT_MATTER_KEY_ORDER[0], PLAN_FRONT_MATTER_KEYS.planId);
    assertEquals(PLAN_FRONT_MATTER_KEYS.frontend, "frontend");
    assertEquals(PLAN_FRONT_MATTER_KEY_ORDER.includes(PLAN_FRONT_MATTER_KEYS.devServerUrl), true);
    assertEquals(PLAN_FRONT_MATTER_KEY_ORDER.map(String).includes("objectiveChecksBaseline"), false);
    assertEquals(PLAN_FRONT_MATTER_KEY_ORDER.map(String).includes("objectiveCheckWaivers"), false);
    assertEquals(PLAN_FRONT_MATTER_KEYS.supersedes, "supersedes");
    assertEquals(PLAN_FRONT_MATTER_KEYS.planDeviations, "planDeviations");
    assertEquals(
        PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.tickets) <
            PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.supersedes),
        true,
    );
    assertEquals(
        PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.supersedes) <
            PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.planDeviations),
        true,
    );
    assertEquals(
        PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.planDeviations) <
            PLAN_FRONT_MATTER_KEY_ORDER.indexOf(PLAN_FRONT_MATTER_KEYS.executionAgent),
        true,
    );
    assertEquals(PLAN_FRONT_MATTER_KEY_ORDER.includes(PLAN_FRONT_MATTER_KEYS.worktreePath), true);
    assertEquals(new Set(PLAN_FRONT_MATTER_KEY_ORDER).size, PLAN_FRONT_MATTER_KEY_ORDER.length);
});

Deno.test("injectFrontMatter escapes YAML double-quoted values", () => {
    const markdown = "## Plan\n\nBody";
    const withFm = injectFrontMatter(markdown, {
        summary: 'Handle "Other" and \\slashes',
        affectedPaths: ['<|"|src/tools/user-interview.js<|"|'],
    });

    const { attrs } = parsePlanFrontMatter(withFm);

    assertEquals(attrs.summary, 'Handle "Other" and \\slashes');
    assertEquals(attrs.affectedPaths, ['<|"|src/tools/user-interview.js<|"|']);
});

Deno.test("injectFrontMatter keeps markdown formatted after front matter updates", () => {
    const firstWrite = injectFrontMatter("# Plan\n\nBody", { status: "draft" });
    const secondWrite = injectFrontMatter(firstWrite, { status: "feedback" });
    const emptyWrite = injectFrontMatter("", { status: "draft" });

    assertStringIncludes(firstWrite, "---\n\n# Plan");
    assertStringIncludes(secondWrite, "---\n\n# Plan");
    assertEquals(parsePlanFrontMatter(emptyWrite).body, "");
});

Deno.test("Plan Deviation metadata round trips as Plan-owned definition", () => {
    const markdown = injectFrontMatter("# Plan\n\nBody", {
        status: "in_progress",
        planDeviations: [
            {
                id: "call-1",
                supersededRequirement: "Replace nav.",
                replacementRequirement: "Keep current nav.",
                reason: "User decided during Pair Execution.",
                approvedAt: "2026-09-10T00:00:00.000Z",
            },
            {
                id: "call-2",
                supersededRequirement: "Use blue.",
                replacementRequirement: "Use green.",
                approvedAt: "2026-09-10T00:01:00.000Z",
            },
        ],
    });

    const { attrs } = parsePlanFrontMatter(markdown);

    assertEquals(attrs.status, "in_progress");
    assertEquals(attrs.planDeviations, [
        {
            id: "call-1",
            supersededRequirement: "Replace nav.",
            replacementRequirement: "Keep current nav.",
            reason: "User decided during Pair Execution.",
            approvedAt: "2026-09-10T00:00:00.000Z",
        },
        {
            id: "call-2",
            supersededRequirement: "Use blue.",
            replacementRequirement: "Use green.",
            approvedAt: "2026-09-10T00:01:00.000Z",
        },
    ]);
    assertStringIncludes(markdown, "planDeviations:\n  - id:");
    assertStringIncludes(markdown, "replacementRequirement:");
});

Deno.test("malformed Plan Deviation metadata blocks Plan parsing", () => {
    assertThrows(
        () =>
            parsePlanFrontMatter(`---
classification: PLANNED_CHANGE
planDeviations:
  - id: call-1
    supersededRequirement: "Old requirement."
    replacementRequirement: " "
    approvedAt: "2026-09-10T00:00:00.000Z"
---
# Plan
`),
        Error,
        "replacementRequirement",
    );
});

Deno.test("Plan Work Record metadata round trips with nested YAML", () => {
    const markdown = "## Plan\n\nBody";
    const withFm = injectFrontMatter(markdown, {
        status: "closed_without_verification",
        closedWithoutVerificationReason: "Verified manually in staging.",
        workRecord: {
            status: "generated",
            recordId: "11111111-1111-4111-8111-111111111111",
            path: "docs/work-records/2026-07-14-example.md",
            lastAttemptAt: "2026-07-14T08:32:00-04:00",
        },
    });

    const { attrs } = parsePlanFrontMatter(withFm);

    assertEquals(attrs.closedWithoutVerificationReason, "Verified manually in staging.");
    assertEquals(attrs.workRecord, {
        status: "generated",
        recordId: "11111111-1111-4111-8111-111111111111",
        path: "docs/work-records/2026-07-14-example.md",
        lastAttemptAt: "2026-07-14T08:32:00-04:00",
    });
    assertStringIncludes(withFm, "closedWithoutVerificationReason:");
    assertStringIncludes(withFm, "workRecord:\n  status:");
});

Deno.test("obsolete Objective Check front matter is ignored by active Plan parsing", () => {
    const parsed = parsePlanFrontMatter(`---
classification: PLANNED_CHANGE
objectiveChecks:
  - id: OC1
    command: "false"
objectiveChecksBaseline:
  recordedAt: now
objectiveCheckWaivers: []
validationObjectiveCheckAttempts: 2
---
# Legacy Plan
`);
    assertEquals("objectiveChecks" in parsed.attrs, false);
    assertEquals("objectiveChecksBaseline" in parsed.attrs, false);
    assertEquals("objectiveCheckWaivers" in parsed.attrs, false);
    assertEquals("validationObjectiveCheckAttempts" in parsed.attrs, false);
});

Deno.test("frontend verification front matter round trips as legacy source metadata", () => {
    const markdown = "## Plan\n\nBody";
    const withFm = injectFrontMatter(markdown, {
        frontend: true,
        devServerCommand: "npm run dev",
        devServerUrl: "http://localhost:5173",
        devServerHmr: true,
    });

    const { attrs } = parsePlanFrontMatter(withFm);

    assertEquals(attrs.frontend, true);
    assertEquals(attrs.executionAgent, undefined);
    assertEquals(resolvePlanExecutionPolicy(attrs), {
        ok: true,
        policy: {
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "autonomous",
            source: "legacy_frontend",
        },
    });
    assertEquals(attrs.devServerCommand, "npm run dev");
    assertEquals(attrs.devServerUrl, "http://localhost:5173");
    assertEquals(attrs.devServerHmr, true);
    assertEquals(withFm.indexOf("affectedPaths:") < withFm.indexOf("frontend:"), true);
    assertEquals(withFm.indexOf("devServerHmr:") < withFm.indexOf("createdAt:"), true);
});

Deno.test("Plan execution policy preserves invalid raw values for diagnostics", () => {
    const { attrs } = parsePlanFrontMatter(`---
classification: FEATURE
executionAgent: typo-agent
collaborationRecommendation: buddy
---
# Bad
`);

    assertEquals(attrs.executionAgent, "typo-agent");
    assertEquals(attrs.collaborationRecommendation, "buddy");
    assertEquals(resolvePlanExecutionPolicy(attrs), {
        ok: false,
        reason: "invalid_execution_agent",
        error: "Invalid executionAgent: typo-agent. Supported values are engineer and frontend-engineer.",
    });
});

Deno.test("Plan execution policy preserves invalid non-string raw values for diagnostics", () => {
    const { attrs } = parsePlanFrontMatter(`---
classification: FEATURE
executionAgent: 123
collaborationRecommendation: false
---
# Bad
`);

    assertEquals(attrs.executionAgent, 123);
    assertEquals(attrs.collaborationRecommendation, false);
    assertEquals(resolvePlanExecutionPolicy(attrs), {
        ok: false,
        reason: "invalid_execution_agent",
        error: "Invalid executionAgent: 123. Supported values are engineer and frontend-engineer.",
    });
    assertThrows(
        () => injectFrontMatter("# Bad\n", { executionAgent: 123 }),
        Error,
        "Invalid executionAgent: 123",
    );
    assertThrows(
        () => injectFrontMatter("# Bad\n", { executionAgent: "frontend-engineer", collaborationRecommendation: false }),
        Error,
        "Invalid collaborationRecommendation: false",
    );
});

Deno.test("Plan execution policy enforces owner and recommendation matrix", () => {
    assertEquals(resolvePlanExecutionPolicy({ classification: "FEATURE" }), {
        ok: true,
        policy: { executionAgent: "engineer", collaborationRecommendation: "autonomous", source: "absent" },
    });
    assertEquals(resolvePlanExecutionPolicy({ classification: "FEATURE", frontend: false }), {
        ok: true,
        policy: {
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
            source: "legacy_frontend_false",
        },
    });
    assertEquals(resolvePlanExecutionPolicy({ classification: "FEATURE", executionAgent: "engineer" }), {
        ok: true,
        policy: { executionAgent: "engineer", collaborationRecommendation: "autonomous", source: "canonical" },
    });
    assertEquals(
        resolvePlanExecutionPolicy({
            classification: "FEATURE",
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
            frontend: false,
        }),
        {
            ok: true,
            policy: { executionAgent: "frontend-engineer", collaborationRecommendation: "pair", source: "canonical" },
        },
    );
    // Pair is a collaboration choice, not a browser capability: an Engineer plan can
    // ask the user to steer between increments just as a Frontend Engineer plan can.
    assertEquals(
        resolvePlanExecutionPolicy({
            classification: "FEATURE",
            executionAgent: "engineer",
            collaborationRecommendation: "pair",
        }),
        {
            ok: true,
            policy: { executionAgent: "engineer", collaborationRecommendation: "pair", source: "canonical" },
        },
    );
    assertEquals(resolvePlanExecutionPolicy({ classification: "PROJECT", frontend: true }), {
        ok: false,
        reason: "project_epic",
        error: "PROJECT Epics are non-executable and do not have an execution owner.",
    });
    assertEquals(resolvePlanExecutionPolicy({ classification: "PROJECT", executionAgent: "engineer" }), {
        ok: false,
        reason: "project_execution_agent",
        error: "PROJECT Epics are non-executable and must not define executionAgent.",
    });
    assertEquals(
        resolvePlanExecutionPolicy({
            classification: "QUICK_FIX",
            executionAgent: "frontend-engineer",
            frontend: true,
        }),
        {
            ok: true,
            policy: { executionAgent: "engineer", collaborationRecommendation: "autonomous", source: "absent" },
        },
    );
});

Deno.test("injectFrontMatter preserves new closure and hold lifecycle fields", () => {
    const markdown = "## Plan\n\nBody";
    const withClosed = injectFrontMatter(markdown, {
        status: "closed_without_verification",
        createdAt: "2026-06-23T00:00:00.000Z",
    });
    assertEquals(parsePlanFrontMatter(withClosed).attrs.status, "closed_without_verification");

    const withHold = injectFrontMatter(markdown, {
        status: "on_hold",
        heldFromStatus: "in_progress",
        heldAt: "2026-06-23T01:00:00.000Z",
        holdReason: "priority shifted",
        holdStalenessBaseline: "2026-06-22T00:00:00.000Z",
        worktreeId: "wt-1",
    });
    const { attrs } = parsePlanFrontMatter(withHold);
    assertEquals(attrs.status, "on_hold");
    assertEquals(attrs.heldFromStatus, "in_progress");
    assertEquals(attrs.heldAt, "2026-06-23T01:00:00.000Z");
    assertEquals(attrs.holdReason, "priority shifted");
    assertEquals(attrs.holdStalenessBaseline, "2026-06-22T00:00:00.000Z");
    assertEquals(
        withHold.indexOf("worktreeStatus:") === -1 ||
            withHold.indexOf("worktreeStatus:") < withHold.indexOf("heldFromStatus:"),
        true,
    );
});

Deno.test("injectFrontMatter clears hold fields with null overrides", () => {
    const withHold = injectFrontMatter("## Plan", {
        status: "on_hold",
        heldFromStatus: "ready_for_work",
        heldAt: "2026-06-23T01:00:00.000Z",
        holdReason: "paused",
        holdStalenessBaseline: "2026-06-22T00:00:00.000Z",
    });
    const cleared = injectFrontMatter(withHold, {
        status: "draft",
        heldFromStatus: null,
        heldAt: null,
        holdReason: null,
        holdStalenessBaseline: null,
    });
    const { attrs } = parsePlanFrontMatter(cleared);
    assertEquals(attrs.status, "draft");
    assertEquals(attrs.heldFromStatus, null);
    assertEquals(attrs.heldAt, undefined);
    assertEquals(attrs.holdReason, undefined);
    assertEquals(attrs.holdStalenessBaseline, undefined);
});

Deno.test("injectFrontMatter preserves human review metadata", () => {
    const markdown = "## Plan\n\nBody";
    const withFm = injectFrontMatter(markdown, {
        classification: "FEATURE",
        complexity: "MEDIUM",
        summary: "Reviewed",
        affectedPaths: [],
        createdAt: "2026-06-23T00:00:00.000Z",
        status: "verified",
        verifiedAt: "2026-06-23T01:30:00.000Z",
        humanReviewMode: "ask",
        humanReviewDecision: "approved",
        humanReviewedAt: "2026-06-23T01:00:00.000Z",
        executionBaselineTree: "tree123",
    });

    const { attrs } = parsePlanFrontMatter(withFm);

    assertEquals(attrs.humanReviewMode, "ask");
    assertEquals(attrs.humanReviewDecision, "approved");
    assertEquals(attrs.humanReviewedAt, "2026-06-23T01:00:00.000Z");
    assertEquals(
        withFm.indexOf("verifiedAt:") < withFm.indexOf("humanReviewMode:") &&
            withFm.indexOf("humanReviewedAt:") < withFm.indexOf("executionBaselineTree:"),
        true,
    );
});

Deno.test("planId round trips and blank values normalize away", () => {
    const withId = injectFrontMatter("## Plan", { planId: "plan-123" });
    assertEquals(parsePlanFrontMatter(withId).attrs.planId, "plan-123");

    const blank = injectFrontMatter("## Plan", { planId: "" });
    assertEquals(parsePlanFrontMatter(blank).attrs.planId, undefined);
    assertEquals(blank.includes("planId:"), false);
});

Deno.test("supersedes front matter normalizes, deduplicates, and round trips in canonical order", () => {
    const recordB = "550e8400-e29b-41d4-a716-446655440000";
    const recordA = "550e8400-e29b-41d4-a716-446655440001";
    const markdown = injectFrontMatter("## Plan", {
        tickets: [{ url: "https://example.com/tickets/ABC-123" }],
        supersedes: [` ${recordB} `, recordA, "", recordB.toUpperCase(), "   "],
        executionAgent: "engineer",
    });
    const { attrs } = parsePlanFrontMatter(markdown);

    assertEquals(attrs.supersedes, [recordB, recordA]);
    assertEquals(markdown.indexOf("tickets:") < markdown.indexOf("supersedes:"), true);
    assertEquals(markdown.indexOf("supersedes:") < markdown.indexOf("executionAgent:"), true);
});

Deno.test("malformed or empty supersedes front matter is omitted", () => {
    const scalar = parsePlanFrontMatter("---\nsupersedes: record-a\n---\n# Plan\n");
    const mixed = parsePlanFrontMatter(
        "---\nsupersedes:\n    - 550e8400-e29b-41d4-a716-446655440000\n    - docs/old-record.md\n---\n# Plan\n",
    );
    const nonString = parsePlanFrontMatter(
        "---\nsupersedes:\n    - 550e8400-e29b-41d4-a716-446655440000\n    - 7\n---\n# Plan\n",
    );
    const malformed = injectFrontMatter("# Plan", { supersedes: ["old-record", "plan-123", "docs/record.md"] });
    const blank = injectFrontMatter("# Plan", { supersedes: [" ", ""] });

    assertEquals(scalar.attrs.supersedes, undefined);
    assertEquals(mixed.attrs.supersedes, undefined);
    assertEquals(nonString.attrs.supersedes, undefined);
    assertEquals(parsePlanFrontMatter(malformed).attrs.supersedes, undefined);
    assertEquals(malformed.includes("supersedes:"), false);
    assertEquals(parsePlanFrontMatter(blank).attrs.supersedes, undefined);
    assertEquals(blank.includes("supersedes:"), false);
});

Deno.test("documentation Work Kind front matter round trips and unknown values normalize away", () => {
    const withDocumentation = injectFrontMatter("## Plan", {
        classification: "PLANNED_CHANGE",
        workKind: "DOCUMENTATION",
    });
    assertEquals(parsePlanFrontMatter(withDocumentation).attrs.workKind, "DOCUMENTATION");
    assertStringIncludes(withDocumentation, 'workKind: "DOCUMENTATION"');

    const unknown = injectFrontMatter("## Plan", { workKind: /** @type {any} */ ("DOCS") });
    assertEquals(parsePlanFrontMatter(unknown).attrs.workKind, undefined);
    assertEquals(unknown.includes("workKind:"), false);
});

Deno.test("order front matter round trips and numeric strings normalize", () => {
    const withOrder = injectFrontMatter("## Plan", { parentPlan: "epic-a", order: 3 });
    assertEquals(parsePlanFrontMatter(withOrder).attrs.order, 3);
    assertEquals(withOrder.includes("parentPlan:"), true);
    assertEquals(withOrder.indexOf("parentPlan:") < withOrder.indexOf("order:"), true);

    const parsedString = parsePlanFrontMatter([
        "---",
        "classification: FEATURE",
        "summary: child",
        "parentPlan: epic-a",
        'order: "4"',
        "---",
        "# Child",
    ].join("\n"));
    assertEquals(parsedString.attrs.order, 4);
});

testWithFs("ensurePlanIdentity backfills missing planId while preserving body exactly", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "missing-id", "\n\n# Title\n\nBody\n", { summary: "Missing ID" });
        const before = await loadPlan(cwd, "missing-id");
        const resource = await ensurePlanIdentity(cwd, "missing-id", { idGenerator: () => "generated-id" });
        const after = await loadPlan(cwd, "missing-id");

        assertEquals(resource.planId, "generated-id");
        assertEquals(after?.attrs.planId, "generated-id");
        assertEquals(after?.body, before?.body);
        assertEquals(resource.relativePath, "docs/plans/missing-id.md");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs(
    "listPlanResources preserves existing IDs, hides archived plans, and retries generated collisions",
    async () => {
        const cwd = await Deno.makeTempDir();
        try {
            await savePlan(cwd, "existing", "# Existing", { planId: "existing-id" });
            await savePlan(cwd, "missing", "# Missing");
            await savePlan(cwd, "archived/hidden", "# Hidden");
            const ids = ["existing-id", "new-id"];

            const resources = await listPlanResources(cwd, {
                backfillMissing: true,
                idGenerator: () => ids.shift() || "fallback-id",
            });

            assertEquals(resources.map((resource) => resource.planName), ["existing", "missing"]);
            assertEquals(resources.map((resource) => resource.planId), ["existing-id", "new-id"]);
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
);

testWithFs("listPlanResources throws repair-oriented duplicate planId errors before backfill", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "a", "# A", { planId: "dup" });
        await savePlan(cwd, "b", "# B", { planId: "dup" });
        await savePlan(cwd, "missing", "# Missing");

        await assertRejects(
            () => listPlanResources(cwd, { idGenerator: () => "new" }),
            Error,
            "Duplicate planId values found",
        );
        assertEquals((await loadPlan(cwd, "missing"))?.attrs.planId, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("findPlanById resolves non-archived plan resources", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "lookup", "# Lookup", { planId: "lookup-id" });
        await savePlan(cwd, "prefixed", "# Prefixed", { planId: "01-prefixed-id" });
        const resource = await findPlanById(cwd, "lookup-id");
        assertEquals(resource.planName, "lookup");
        assertEquals(resource.relativePath, "docs/plans/lookup.md");
        const prefixed = await findPlanById(cwd, "prefixed-id");
        assertEquals(prefixed.planName, "prefixed");

        await assertRejects(() => findPlanById(cwd, "missing-id"), Error, "Plan not found for planId");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("splitPlanMarkdownBody preserves front matter delimiter bytes and body", () => {
    const markdown = "---\r\n# comment\r\nplanId: quoted\r\n---\r\n# Body\n\nText\n";
    const split = splitPlanMarkdownBody(markdown);
    assertEquals(split.frontMatterBlock, "---\r\n# comment\r\nplanId: quoted\r\n---\r\n");
    assertEquals(split.body, "# Body\n\nText\n");
});

Deno.test("splitPlanMarkdownBody ignores indented front matter delimiter-like content", () => {
    const markdown = "---\nsummary: |\n  ---\n  body marker remains metadata\n---\n# Body\n";
    const split = splitPlanMarkdownBody(markdown);
    assertEquals(split.frontMatterBlock, "---\nsummary: |\n  ---\n  body marker remains metadata\n---\n");
    assertEquals(split.body, "# Body\n");
});

testWithFs("body-only save preserves front matter bytes and markdown body fidelity", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await Deno.mkdir(`${cwd}/docs/plans`, { recursive: true });
        const frontMatter = [
            "---",
            "# preserve this comment",
            "planId: body-id",
            'unknownKey: "kept"',
            "classification: FEATURE",
            "status: in_progress",
            "worktreeStatus: active",
            "dependencies:",
            "    - sibling",
            "---\n",
        ].join("\n");
        const body =
            "# Old\n\n- item\n- [ ] task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[RunWield](https://runwield.dev)\n\n```js\nconsole.log(1);\n```\n";
        await Deno.writeTextFile(`${cwd}/docs/plans/body.md`, frontMatter + body);
        const loaded = await loadPlanBodyById(cwd, "body-id");
        const nextBody =
            "# New\n\n- item\n- [x] task\n\n| A | B |\n| - | - |\n| 3 | 4 |\n\n[RunWield](https://runwield.dev)\n\n```js\nconsole.log(2);\n```\n\n";

        const saved = await savePlanBodyByIdForTest(cwd, "body-id", nextBody, loaded.bodyHash);
        const after = await Deno.readTextFile(`${cwd}/docs/plans/body.md`);

        assertEquals(after, frontMatter.replace("worktreeStatus: active\n", "") + nextBody);
        assertEquals(saved.body, nextBody);
        assertEquals(saved.bodyHash, await hashPlanBody(nextBody));
        assertEquals(parsePlanFrontMatter(after).attrs.status, "in_progress");
        assertEquals(parsePlanFrontMatter(after).attrs.worktreeStatus, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("body-only save rejects stale hashes duplicate IDs and archived plans", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "editable", "# Original", { planId: "editable-id" });
        const loaded = await loadPlanBodyById(cwd, "editable-id");
        await savePlanBodyByIdForTest(cwd, "editable-id", "# External", loaded.bodyHash);
        await assertRejects(
            () => savePlanBodyByIdForTest(cwd, "editable-id", "# Browser", loaded.bodyHash),
            Error,
            "changed on disk",
        );

        await savePlan(cwd, "dup-a", "# A", { planId: "dup" });
        await savePlan(cwd, "dup-b", "# B", { planId: "dup" });
        await assertRejects(() => loadPlanBodyById(cwd, "dup"), Error, "Duplicate planId values found");
        await Deno.remove(`${cwd}/docs/plans/dup-a.md`);
        await Deno.remove(`${cwd}/docs/plans/dup-b.md`);

        await savePlan(cwd, "archived/hidden", "# Hidden", { planId: "hidden-id" });
        await assertRejects(() => loadPlanBodyById(cwd, "hidden-id"), Error, "Plan not found for planId");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("groupPlanHierarchy groups Epics, nested children, standalone, and orphaned children", () => {
    const plans = [
        { name: "epic", path: "docs/plans/epic.md", attrs: { classification: "PROJECT", status: "draft" } },
        {
            name: "epic/child",
            path: "docs/plans/epic/child.md",
            attrs: { classification: "FEATURE", parentPlan: "epic", status: "verified" },
        },
        { name: "solo", path: "docs/plans/solo.md", attrs: { classification: "FEATURE", status: "draft" } },
        {
            name: "orphan/child",
            path: "docs/plans/orphan/child.md",
            attrs: { classification: "FEATURE", parentPlan: "missing", status: "failed" },
        },
    ];

    const grouped = groupPlanHierarchy(/** @type {any} */ (plans));
    assertEquals(grouped.epics.map((plan) => plan.name), ["epic"]);
    assertEquals((grouped.childrenByParent.get("epic") || []).map((plan) => plan.name), ["epic/child"]);
    assertEquals(grouped.standalone.map((plan) => plan.name), ["solo"]);
    assertEquals(grouped.orphanChildren.map((plan) => plan.name), ["orphan/child"]);
    assertEquals(countChildPlanProgress(/** @type {any} */ (plans.slice(1, 4))), {
        verified: 1,
        userVerified: 0,
        completed: 1,
        active: 0,
        failed: 1,
        onHold: 0,
        remaining: 1,
        total: 3,
        byStatus: { verified: 1, failed: 1, draft: 1 },
    });
});

testWithFs("updatePlanStatus fails closed on malformed front matter and preserves bytes", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plansDir = `${cwd}/docs/plans`;
        await Deno.mkdir(plansDir, { recursive: true });
        const planPath = `${plansDir}/broken.md`;

        const malformed = [
            "---",
            'classification: "FEATURE"',
            'summary: "bad "quote"',
            "affectedPaths:",
            '    - "<|"|src/tools/user-interview.js<|"|"',
            'status: "in_review"',
            "---",
            "## Objective",
            "Keep going",
            "",
        ].join("\n");
        await Deno.writeTextFile(planPath, malformed);

        await assertRejects(
            () =>
                updatePlanStatusForTest(cwd, "broken", "approved", {
                    classification: "FEATURE",
                    complexity: "LOW",
                    summary: "Recovered summary",
                    affectedPaths: ["src/tools/user-interview.js"],
                    origin: "internal",
                }),
            PlanFrontMatterParseError,
            planPath,
        );

        assertEquals(await Deno.readTextFile(planPath), malformed);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store saves and reloads on-hold metadata without normalizing to draft", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "held-plan", "## Objective\nPause", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Paused plan",
            affectedPaths: ["src/plan-store.js"],
            status: "on_hold",
            heldFromStatus: "implemented",
            heldAt: "2026-06-23T01:00:00.000Z",
            holdReason: "priority shifted",
            holdStalenessBaseline: "2026-06-22T00:00:00.000Z",
            createdAt: "2026-06-23T00:00:00.000Z",
        });

        const loaded = await loadPlan(cwd, "held-plan");
        assertEquals(loaded?.attrs.status, "on_hold");
        assertEquals(loaded?.attrs.heldFromStatus, "implemented");
        assertEquals(loaded?.attrs.heldAt, "2026-06-23T01:00:00.000Z");
        assertEquals(loaded?.attrs.holdReason, "priority shifted");
        assertEquals(loaded?.attrs.holdStalenessBaseline, "2026-06-22T00:00:00.000Z");

        const updated = await updatePlanFrontMatterForTest(cwd, "held-plan", {
            status: "draft",
            heldFromStatus: null,
            heldAt: null,
            holdReason: null,
            holdStalenessBaseline: null,
        });
        assertEquals(updated.status, "draft");
        assertEquals(updated.heldFromStatus, null);
        assertEquals(updated.heldAt, undefined);
        assertEquals(updated.holdReason, undefined);
        assertEquals(updated.holdStalenessBaseline, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store saves and reloads manual closure status without verified metadata", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "closed-plan", "## Objective\nClose", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Closed plan",
            affectedPaths: [],
            status: "closed_without_verification",
            createdAt: "2026-06-23T00:00:00.000Z",
        });

        const loaded = await loadPlan(cwd, "closed-plan");
        assertEquals(loaded?.attrs.status, "closed_without_verification");
        assertEquals(loaded?.attrs.verifiedAt, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store saves, loads, lists, and resolves project plans", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const savedPath = await savePlan(
            cwd,
            "ship-tests",
            "## Context\nCoverage push\n\n## Objective\nGrow coverage",
            {
                classification: "PROJECT",
                complexity: "HIGH",
                summary: "Coverage push",
                affectedPaths: ["src/plan-store.js"],
                status: "ready_for_work",
                createdAt: "2026-06-15T00:00:00.000Z",
            },
        );

        assertEquals(savedPath, `${getPlansDir(cwd)}/ship-tests.md`);

        const loaded = await loadPlan(cwd, "ship-tests");
        assertEquals(loaded?.attrs.classification, "PROJECT");
        assertEquals(loaded?.attrs.status, "ready_for_work");
        assertEquals(loaded?.body.trim(), "## Context\nCoverage push\n\n## Objective\nGrow coverage");

        const listed = await listPlans(cwd);
        assertEquals(listed.map((plan) => plan.name), ["ship-tests"]);
        assertEquals(listed[0].attrs.summary, "Coverage push");

        const resolvedByName = await resolvePlan(cwd, "ship-tests");
        assertEquals(resolvedByName.planName, "ship-tests");
        assertEquals(resolvedByName.attrs.complexity, "HIGH");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("savePlan refuses unversioned overwrites of existing canonical Plans", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "requires-cas", "# Original", { status: "draft", planId: "requires-cas-id" });
        await assertRejects(
            () => savePlan(cwd, "requires-cas", "# Overwrite", { status: "draft" }),
            StalePlanWriteError,
        );
        const loaded = await loadPlan(cwd, "requires-cas");
        if (!loaded) throw new Error("Expected Plan to exist");
        await savePlan(cwd, "requires-cas", "# Overwrite", { status: "draft" }, {
            expectedRevision: loaded.revision,
        });
        assertEquals((await loadPlan(cwd, "requires-cas"))?.body.trim(), "# Overwrite");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("listPlans fails closed with typed parse errors for malformed active Plans", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "valid", "# Valid", { status: "draft" });
        await Deno.writeTextFile(`${getPlansDir(cwd)}/broken.md`, "---\nstatus: [unterminated\n---\n# Broken\n");

        await assertRejects(() => listPlans(cwd), PlanFrontMatterParseError, "broken.md");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("listPlans sorts by status, classification, then name", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plans = [
            ["z-failed-feature", "FEATURE", "failed"],
            ["z-failed-project", "PROJECT", "failed"],
            ["a-failed-project", "PROJECT", "failed"],
            ["implemented-feature", "FEATURE", "implemented"],
            ["ready-feature", "FEATURE", "ready_for_work"],
            ["ready-project", "PROJECT", "ready_for_work"],
            ["decompose-project", "PROJECT", "ready_for_decomposition"],
            ["draft-feature", "FEATURE", "draft"],
            ["feedback-feature", "FEATURE", "feedback"],
            ["approved-feature", "FEATURE", "approved"],
            ["in-progress-feature", "FEATURE", "in_progress"],
            ["verified-feature", "FEATURE", "verified"],
            ["closed-feature", "FEATURE", "closed_without_verification"],
            ["held-feature", "FEATURE", "on_hold"],
        ];
        for (const [name, classification, status] of plans) {
            await savePlan(cwd, name, `# ${name}`, {
                classification: /** @type {any} */ (classification),
                status: /** @type {any} */ (status),
            });
        }

        assertEquals((await listPlans(cwd)).map((plan) => plan.name), [
            "a-failed-project",
            "z-failed-project",
            "z-failed-feature",
            "implemented-feature",
            "ready-project",
            "ready-feature",
            "decompose-project",
            "draft-feature",
            "feedback-feature",
            "approved-feature",
            "in-progress-feature",
            "verified-feature",
            "closed-feature",
            "held-feature",
        ]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store preserves Epic and nested child metadata", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "project-breakdown-epic", "# Epic", {
            classification: "PROJECT",
            complexity: "HIGH",
            summary: "Break down projects",
            affectedPaths: ["src/plan-store.js"],
            status: "ready_for_work",
            createdAt: "2026-06-16T00:00:00.000Z",
        });

        await savePlan(cwd, "project-breakdown-epic/feature1", "# Child", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Child slice",
            affectedPaths: ["src/plan-store.test.js"],
            status: "draft",
            parentPlan: "project-breakdown-epic",
            dependencies: ["feature0", "project-breakdown-epic/feature0"],
            createdAt: "2026-06-16T01:00:00.000Z",
        });

        const epic = await loadPlan(cwd, "project-breakdown-epic");
        assertEquals(epic?.attrs.classification, "PROJECT");

        const child = await loadPlan(cwd, "project-breakdown-epic/feature1");
        assertEquals(child?.attrs.parentPlan, "project-breakdown-epic");
        assertEquals(child?.attrs.dependencies, ["feature0", "project-breakdown-epic/feature0"]);

        const listed = await listPlans(cwd);
        assertEquals(listed.map((plan) => plan.name), ["project-breakdown-epic", "project-breakdown-epic/feature1"]);

        const resolvedChild = await resolvePlan(cwd, "project-breakdown-epic/feature1");
        assertEquals(resolvedChild.planName, "project-breakdown-epic/feature1");
        assertEquals(resolvedChild.attrs.parentPlan, "project-breakdown-epic");

        const resolvedChildWithExtension = await resolvePlan(cwd, "project-breakdown-epic/feature1.md");
        assertEquals(resolvedChildWithExtension.planName, "project-breakdown-epic/feature1");

        const children = await findPlansByParent(cwd, "project-breakdown-epic");
        assertEquals(children.map((plan) => plan.name), ["project-breakdown-epic/feature1"]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("listPlans hides archived plans", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "active-plan", "# Active", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Visible plan",
            affectedPaths: [],
            status: "draft",
            createdAt: "2026-06-18T00:00:00.000Z",
        });
        await savePlan(cwd, "archived/old-plan", "# Archived\n\n## Context\nHidden plan", {
            classification: "FEATURE",
            complexity: "LOW",
            summary: "Hidden plan",
            affectedPaths: [],
            status: "verified",
            createdAt: "2026-06-17T00:00:00.000Z",
        });

        const listed = await listPlans(cwd);
        assertEquals(listed.map((plan) => plan.name), ["active-plan"]);

        const explicitArchived = await loadPlan(cwd, "archived/old-plan");
        assertEquals(explicitArchived?.attrs.summary, "Hidden plan");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlan moves verified nested plans with metadata and hides them from active lists", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic/01-child", "# Child\n\nBody stays", {
            planId: "child-id",
            summary: "Child plan",
            status: "verified",
            createdAt: "2026-06-18T00:00:00.000Z",
        });

        const archived = await archivePlan(cwd, "child-id", {
            reason: "done",
            now: "2026-06-19T00:00:00.000Z",
        });

        assertEquals(archived.name, "epic/01-child");
        assertEquals(archived.relativePath, "docs/plans/archived/epic/01-child.md");
        assertEquals((await listPlans(cwd)).map((plan) => plan.name), []);
        assertEquals((await listArchivedPlans(cwd)).map((plan) => plan.name), ["epic/01-child"]);

        const loaded = await loadArchivedPlan(cwd, "epic/01-child");
        assertEquals(loaded?.attrs.status, "verified");
        assertEquals(loaded?.attrs.archivedAt, "2026-06-19T00:00:00.000Z");
        assertEquals(loaded?.attrs.archiveReason, "done");
        assertEquals(loaded?.attrs.archivedFromStatus, "verified");
        assertEquals(loaded?.attrs.archivedFromPath, "docs/plans/epic/01-child.md");
        assertEquals(loaded?.body, "# Child\n\nBody stays");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlan allows terminal closure and requires force for non-terminal statuses", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "closed", "# Closed", { status: "closed_without_verification" });
        await archivePlan(cwd, "closed", { now: "2026-06-19T00:00:00.000Z" });
        assertEquals((await loadArchivedPlan(cwd, "closed"))?.attrs.archivedFromStatus, "closed_without_verification");

        await savePlan(cwd, "draft", "# Draft", { status: "draft" });
        await assertRejects(() => archivePlan(cwd, "draft"), Error, "without --force");
        await archivePlan(cwd, "draft", { force: true, now: "2026-06-20T00:00:00.000Z" });
        assertEquals((await loadArchivedPlan(cwd, "draft"))?.attrs.archivedFromStatus, "draft");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlan refuses recoverable worktree states and refuses overwrites", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "busy", "# Busy", { status: "verified", worktreeStatus: "active" });
        await recordActiveAttempt(cwd, "busy");
        await assertRejects(() => archivePlan(cwd, "busy"), Error, "worktreeStatus active");
        await assertRejects(() => archivePlan(cwd, "busy", { force: true }), Error, "--force does not bypass");

        await savePlan(cwd, "dup", "# Dup", { status: "verified" });
        await savePlan(cwd, "archived/dup", "# Archived Dup", { status: "verified" });
        await assertRejects(() => archivePlan(cwd, "dup"), Error, "already exists");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlansByStatus archives matching parents with all children and reports no-op matches", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            status: "verified",
            summary: "Done",
        });
        await savePlan(cwd, "epic/01-child", "# Child", {
            parentPlan: "epic",
            status: "draft",
            summary: "Child",
        });
        await savePlan(cwd, "standalone", "# Standalone", { status: "verified", summary: "Done" });
        await savePlan(cwd, "draft", "# Draft", { status: "draft" });
        await savePlan(cwd, "closed", "# Closed", { status: "closed_without_verification" });

        const result = await archivePlansByStatus(cwd, "verified", {
            reason: "done",
            now: "2026-07-04T00:00:00.000Z",
        });

        assertEquals(result.matched.map((plan) => plan.name), ["epic", "epic/01-child", "standalone"]);
        assertEquals(result.archived.map((plan) => plan.relativePath), [
            "docs/plans/archived/epic.md",
            "docs/plans/archived/epic/01-child.md",
            "docs/plans/archived/standalone.md",
        ]);
        assertEquals(result.failed, []);
        assertEquals((await listPlans(cwd)).map((plan) => plan.name), ["draft", "closed"]);
        const archivedChild = await loadArchivedPlan(cwd, "epic/01-child");
        assertEquals(archivedChild?.attrs.archivedAt, "2026-07-04T00:00:00.000Z");
        assertEquals(archivedChild?.attrs.archiveReason, "done");
        assertEquals(archivedChild?.attrs.archivedFromStatus, "draft");

        const noOp = await archivePlansByStatus(cwd, "verified", { now: "2026-07-05T00:00:00.000Z" });
        assertEquals(noOp, { matched: [], archived: [], failed: [] });
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlansByStatus ignores children when parent status does not match", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            status: "draft",
        });
        await savePlan(cwd, "epic/01-child", "# Child", { parentPlan: "epic", status: "verified" });

        const result = await archivePlansByStatus(cwd, "verified", { now: "2026-07-04T00:00:00.000Z" });

        assertEquals(result, { matched: [], archived: [], failed: [] });
        assertEquals((await listPlans(cwd)).map((plan) => plan.name), ["epic", "epic/01-child"]);
        assertEquals(await listArchivedPlans(cwd), []);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlansByStatus keeps archiving safe matches when other matches fail", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "ok", "# OK", { status: "verified" });
        await savePlan(cwd, "blocked", "# Blocked", { status: "verified", worktreeStatus: "active" });
        await recordActiveAttempt(cwd, "blocked");
        await savePlan(cwd, "dup", "# Dup", { status: "verified" });
        await savePlan(cwd, "archived/dup", "# Existing", { status: "verified" });

        const result = await archivePlansByStatus(cwd, "verified", { now: "2026-07-04T00:00:00.000Z" });

        assertEquals(result.matched.map((plan) => plan.name), ["blocked", "dup", "ok"]);
        assertEquals(result.archived, [{ name: "ok", relativePath: "docs/plans/archived/ok.md" }]);
        assertEquals(result.failed.map((plan) => plan.name), ["blocked", "dup"]);
        assertStringIncludes(result.failed[0].message, "worktreeStatus active");
        assertStringIncludes(result.failed[1].message, "already exists");
        assertEquals((await listPlans(cwd)).map((plan) => plan.name), ["blocked", "dup"]);
        assertEquals((await listArchivedPlans(cwd)).map((plan) => plan.name), ["dup", "ok"]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archivePlansByStatus validates requested lifecycle status", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await assertRejects(
            () => archivePlansByStatus(cwd, /** @type {any} */ ("verfied")),
            Error,
            "Unknown Plan status",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("deleteArchivedPlanUnit removes a top-level archived Epic unit", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
        await savePlan(cwd, "epic/01-child", "# Child", {
            classification: "FEATURE",
            parentPlan: "epic",
            status: "verified",
        });
        await savePlan(cwd, "solo", "# Solo", { status: "verified" });
        await archivePlan(cwd, "epic/01-child", { now: "2026-08-01T00:00:00Z" });
        await archivePlan(cwd, "epic", { now: "2026-08-01T00:00:00Z" });
        await archivePlan(cwd, "solo", { now: "2026-08-01T00:00:00Z" });

        const removed = await deleteArchivedPlanUnit(cwd, "epic");

        assertEquals(removed, ["docs/plans/archived/epic.md", "docs/plans/archived/epic/01-child.md"]);
        await assertRejects(() => Deno.stat(join(cwd, "docs", "plans", "archived", "epic.md")), Deno.errors.NotFound);
        await assertRejects(() => Deno.stat(join(cwd, "docs", "plans", "archived", "epic")), Deno.errors.NotFound);
        assertEquals((await loadArchivedPlan(cwd, "solo"))?.body, "# Solo");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("deleteArchivedPlanUnit refuses unsafe or partial deletions", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "o", "# O", { status: "verified" });
        await archivePlan(cwd, "o", { now: "2026-08-01T00:00:00Z" });
        await Deno.mkdir(join(cwd, "docs", "plans", "archived", "o"));
        await Deno.writeTextFile(join(cwd, "docs", "plans", "archived", "o", "notes.txt"), "keep\n");

        await assertRejects(() => deleteArchivedPlanUnit(cwd, "missing"), Error, "Archived Plan not found");
        await assertRejects(() => deleteArchivedPlanUnit(cwd, "o/nested"), Error, "top-level");
        await assertRejects(() => deleteArchivedPlanUnit(cwd, "o"), Error, "non-markdown entry");

        assertEquals((await loadArchivedPlan(cwd, "o"))?.body, "# O");
        assertEquals(await Deno.readTextFile(join(cwd, "docs", "plans", "archived", "o", "notes.txt")), "keep\n");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs(
    "restoreArchivedPlan moves archived plans back without changing body and refuses active overwrites",
    async () => {
        const cwd = await Deno.makeTempDir();
        try {
            await savePlan(cwd, "done", "# Done\n\nBody", { status: "verified", planId: "done-id" });
            await archivePlan(cwd, "done", { now: "2026-06-19T00:00:00.000Z" });
            const restored = await restoreArchivedPlan(cwd, "done-id", { now: "2026-06-20T00:00:00.000Z" });

            assertEquals(restored.relativePath, "docs/plans/done.md");
            const loaded = await loadPlan(cwd, "done");
            assertEquals(loaded?.body, "# Done\n\nBody");
            assertEquals(loaded?.attrs.archivedAt, undefined);
            assertEquals(loaded?.attrs.archiveReason, undefined);
            assertEquals(loaded?.attrs.archivedFromStatus, undefined);
            assertEquals(loaded?.attrs.archivedFromPath, undefined);
            assertEquals(loaded?.attrs.restoredAt, "2026-06-20T00:00:00.000Z");
            assertEquals(loaded?.attrs.restoredFromPath, "docs/plans/archived/done.md");

            await savePlan(cwd, "archived/old", "# Old", { status: "verified" });
            await savePlan(cwd, "old", "# Active", { status: "draft" });
            await assertRejects(() => restoreArchivedPlan(cwd, "old"), Error, "already exists");
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
);

testWithFs("archived plan store resolves planId and preserves custom front matter text", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const planPath = `${getPlansDir(cwd)}/custom.md`;
        await Deno.mkdir(getPlansDir(cwd), { recursive: true });
        await Deno.writeTextFile(
            planPath,
            [
                "---",
                "planId: durable-custom-id",
                "classification: FEATURE",
                "complexity: MEDIUM",
                "summary: Custom metadata",
                "affectedPaths:",
                "    []",
                "status: verified",
                "customObject:",
                "  nested: true",
                "# keep this comment with the custom field",
                "---",
                "# Custom Body",
                "",
            ].join("\n"),
        );

        await archivePlan(cwd, "custom", { now: "2026-06-21T00:00:00.000Z" });
        const archived = await loadArchivedPlan(cwd, "durable-custom-id");
        assertEquals(archived?.name, "custom");
        assertEquals(archived?.attrs.archivedAt, "2026-06-21T00:00:00.000Z");
        assertStringIncludes(archived?.markdown || "", "customObject:\n  nested: true");
        assertStringIncludes(archived?.markdown || "", "# keep this comment with the custom field");
        assertEquals(archived?.body, "# Custom Body\n");

        await restoreArchivedPlan(cwd, "durable-custom-id", { now: "2026-06-22T00:00:00.000Z" });
        const restoredMarkdown = await Deno.readTextFile(planPath);
        assertStringIncludes(restoredMarkdown, "customObject:\n  nested: true");
        assertStringIncludes(restoredMarkdown, "# keep this comment with the custom field");
        assertStringIncludes(restoredMarkdown, 'restoredAt: "2026-06-22T00:00:00.000Z"');
        assertStringIncludes(restoredMarkdown, "# Custom Body\n");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archived listing skips malformed files while direct reads report parse errors", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "archived/good", "# Good", { status: "verified", planId: "good-id" });
        await Deno.writeTextFile(
            `${getPlansDir(cwd)}/archived/bad.md`,
            "---\nsummary: [unterminated\n---\n# Bad\n",
        );

        const listed = await listArchivedPlans(cwd);
        assertEquals(listed.map((plan) => plan.name), ["good"]);
        await assertRejects(
            () => loadArchivedPlan(cwd, "bad"),
            Error,
            "Malformed archived Plan docs/plans/archived/bad.md",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archive helpers reject traversal and active archive source names", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "archived/old", "# Old", { status: "verified" });
        await assertRejects(() => archivePlan(cwd, "archived/old"), Error, "active Plan name");
        await assertRejects(() => loadArchivedPlan(cwd, "../escape"), Error, "cannot escape");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("saveChildFeaturePlans creates draft child FEATURE plans with order and legacy sequence alias", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const results = await saveChildFeaturePlans(cwd, "project-breakdown-epic", [
            {
                order: 1,
                title: "Preserve Epic and child metadata",
                summary: "Keep parent-child links loadable",
                affectedPaths: ["src/plan-store.js"],
                frontend: true,
                devServerCommand: "deno task workspace:dev",
                devServerUrl: "http://localhost:5173",
                devServerHmr: true,
                worktreeBaseBranch: "feature-base",
                dependencies: [],
                content: "# Preserve Epic and child metadata\n\n## Context\nDraft slice",
            },
            {
                sequence: 2,
                title: "Load child FEATURES",
                summary: "Let load-plan execute child features",
                affectedPaths: ["src/cmd/load-plan/index.ts"],
                dependencies: ["project-breakdown-epic/01-preserve-epic-and-child-metadata"],
                workKind: "DOCUMENTATION",
                content: "# Load child FEATURES\n\n## Context\nDraft slice",
            },
        ]);

        assertEquals(results.map((result) => ({ name: result.name, action: result.action })), [
            { name: "project-breakdown-epic/01-preserve-epic-and-child-metadata", action: "created" },
            { name: "project-breakdown-epic/02-load-child-features", action: "created" },
        ]);
        assertEquals(results[0].metadata, {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: "project-breakdown-epic",
            order: 1,
            affectedPaths: ["src/plan-store.js"],
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "autonomous",
            devServerCommand: "deno task workspace:dev",
            devServerUrl: "http://localhost:5173",
            devServerHmr: true,
            targetBranch: "feature-base",
        });

        const first = await loadPlan(cwd, "project-breakdown-epic/01-preserve-epic-and-child-metadata");
        assertEquals(first?.attrs.classification, "PLANNED_CHANGE");
        assertEquals(first?.attrs.status, "draft");
        assertEquals(first?.attrs.parentPlan, "project-breakdown-epic");
        assertEquals(first?.attrs.summary, "Draft slice");
        assertEquals(first?.attrs.order, 1);
        assertEquals(first?.attrs.frontend, undefined);
        assertEquals(first?.attrs.executionAgent, "frontend-engineer");
        assertEquals(first?.attrs.collaborationRecommendation, "autonomous");
        assertEquals(first?.attrs.devServerCommand, "deno task workspace:dev");
        assertEquals(first?.attrs.devServerUrl, "http://localhost:5173");
        assertEquals(first?.attrs.devServerHmr, true);
        assertEquals(first?.attrs.targetBranch, "feature-base");

        const second = await loadPlan(cwd, "project-breakdown-epic/02-load-child-features");
        assertEquals(second?.attrs.dependencies, ["project-breakdown-epic/01-preserve-epic-and-child-metadata"]);
        assertEquals(second?.attrs.workKind, "DOCUMENTATION");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("saveChildFeaturePlans rejects invalid child policies before writing any files", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await assertRejects(
            () =>
                saveChildFeaturePlans(cwd, "project-breakdown-epic", [
                    {
                        order: 1,
                        title: "Valid child",
                        summary: "This child would be valid",
                        affectedPaths: ["src/a.js"],
                        executionAgent: "engineer",
                        dependencies: [],
                        content: "# Valid child\n",
                    },
                    {
                        order: 2,
                        title: "Invalid child",
                        summary: "Collaboration recommendation is not a supported value",
                        affectedPaths: ["src/b.js"],
                        executionAgent: "engineer",
                        // @ts-expect-error Child descriptors arrive as Slicer tool JSON, so the
                        // runtime guard must hold for values the descriptor type forbids.
                        collaborationRecommendation: "sometimes",
                        dependencies: [],
                        content: "# Invalid child\n",
                    },
                ]),
            Error,
            "Invalid collaborationRecommendation: sometimes",
        );
        assertEquals(await loadPlan(cwd, "project-breakdown-epic/01-valid-child"), null);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("findPlansByParent sorts child plans by order before name", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic-sort", "# Epic", {
            classification: "PROJECT",
            status: "ready_for_work",
        });
        await savePlan(cwd, "epic-sort/03-third", "# Third", { parentPlan: "epic-sort", order: 3 });
        await savePlan(cwd, "epic-sort/01-legacy", "# Legacy", { parentPlan: "epic-sort" });
        await savePlan(cwd, "epic-sort/02-second", "# Second", { parentPlan: "epic-sort", order: 2 });
        await savePlan(cwd, "epic-sort/04-also-second", "# Also Second", { parentPlan: "epic-sort", order: 2 });

        const children = await findPlansByParent(cwd, "epic-sort");
        assertEquals(children.map((child) => child.name), [
            "epic-sort/02-second",
            "epic-sort/04-also-second",
            "epic-sort/03-third",
            "epic-sort/01-legacy",
        ]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("saveChildFeaturePlans updates existing drafts at stable child paths", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const descriptor = {
            sequence: 1,
            title: "Write Draft Plans",
            summary: "Initial summary",
            affectedPaths: ["src/plan-store.js"],
            dependencies: [],
            content: "# Write Draft Plans\n\nInitial content",
        };
        await saveChildFeaturePlans(cwd, "epic-a", [descriptor]);

        const results = await saveChildFeaturePlans(cwd, "epic-a", [{
            ...descriptor,
            summary: "Updated summary",
            content: "# Write Draft Plans\n\n## Context\nUpdated summary\n\nUpdated content",
        }]);

        assertEquals(results[0].action, "updated");
        const loaded = await loadPlan(cwd, "epic-a/01-write-draft-plans");
        assertEquals(loaded?.attrs.summary, "Updated summary");
        assertEquals(loaded?.body.trim(), "# Write Draft Plans\n\n## Context\nUpdated summary\n\nUpdated content");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("saveChildFeaturePlans rejects invalid child and parent names", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const validChild = {
            sequence: 1,
            title: "Draft child",
            summary: "Draft summary",
            affectedPaths: [],
            dependencies: [],
            content: "# Draft child",
        };

        await assertRejects(
            () => saveChildFeaturePlans(cwd, "../outside", []),
            Error,
            "Plan name cannot escape docs/plans/",
        );
        await assertRejects(
            () => saveChildFeaturePlans(cwd, "/tmp/outside", []),
            Error,
            "Plan name must be relative to docs/plans/",
        );
        await assertRejects(
            () => saveChildFeaturePlans(cwd, "epic-a/nested", [validChild]),
            Error,
            "Parent Epic plan name must be a top-level plan",
        );
        await assertRejects(
            () =>
                saveChildFeaturePlans(cwd, "epic-a", [{
                    sequence: 1,
                    title: "...",
                    summary: "Bad child",
                    affectedPaths: [],
                    dependencies: [],
                    content: "# Bad",
                }]),
            Error,
            "Child plan title must produce a valid plan name",
        );
        await assertRejects(
            () => saveChildFeaturePlans(cwd, "epic-a", [{ ...validChild, sequence: -1 }]),
            Error,
            "Child plan order must be a non-negative integer",
        );
        await assertRejects(
            () => saveChildFeaturePlans(cwd, "epic-a", [{ ...validChild, sequence: 1.5 }]),
            Error,
            "Child plan order must be a non-negative integer",
        );
        await assertRejects(
            () =>
                saveChildFeaturePlans(cwd, "epic-a", [
                    { ...validChild, title: "Same child" },
                    { ...validChild, title: "Same child" },
                ]),
            Error,
            "Duplicate child plan name: epic-a/01-same-child",
        );
        await assertRejects(
            () =>
                saveChildFeaturePlans(
                    cwd,
                    "epic-a",
                    /** @type {any} */ ([{ ...validChild, dependencies: "feature-1" }]),
                ),
            Error,
            "Child plan dependencies must be an array",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store updates preserve parent-child metadata and unknown front matter", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const markdown = injectFrontMatter(
            "# Child",
            /** @type {any} */ ({
                classification: "FEATURE",
                parentPlan: "project-breakdown-epic",
                dependencies: ["feature0"],
                customFlag: true,
                customOrder: 7,
                customTags: ["alpha", "beta"],
            }),
        );
        await Deno.mkdir(`${cwd}/docs/plans/project-breakdown-epic`, { recursive: true });
        await Deno.writeTextFile(`${cwd}/docs/plans/project-breakdown-epic/feature2.md`, markdown);

        await updatePlanStatusForTest(cwd, "project-breakdown-epic/feature2", "approved");
        const afterStatus = await loadPlan(cwd, "project-breakdown-epic/feature2");
        assertEquals(afterStatus?.attrs.status, "approved");
        assertEquals(afterStatus?.attrs.parentPlan, "project-breakdown-epic");
        assertEquals(afterStatus?.attrs.dependencies, ["feature0"]);
        assertEquals(/** @type {any} */ (afterStatus?.attrs).customFlag, true);
        assertEquals(/** @type {any} */ (afterStatus?.attrs).customOrder, 7);
        assertEquals(/** @type {any} */ (afterStatus?.attrs).customTags, ["alpha", "beta"]);

        const attrs = await updatePlanFrontMatterForTest(cwd, "project-breakdown-epic/feature2", {
            status: "ready_for_work",
            summary: "Updated child",
        });
        assertEquals(attrs.status, "ready_for_work");
        assertEquals(attrs.parentPlan, "project-breakdown-epic");
        assertEquals(attrs.dependencies, ["feature0"]);
        assertEquals(/** @type {any} */ (attrs).customFlag, true);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store rejects stored plan names that escape plans directory", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await assertRejects(
            () => savePlan(cwd, "../outside", "# Bad"),
            Error,
            "Plan name cannot escape docs/plans/",
        );
        await assertRejects(
            () => savePlan(cwd, "/tmp/outside", "# Bad"),
            Error,
            "Plan name must be relative to docs/plans/",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("plan-store resolves external plans and injects defaults when front matter is missing", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const externalPath = `${cwd}/outside.md`;
        await Deno.writeTextFile(externalPath, "# External plan\n\nBody");

        const loaded = await loadExternalPlan(externalPath);
        assertEquals(loaded.attrs.origin, "external");
        assertEquals(loaded.attrs.status, "draft");
        assertEquals(loaded.markdown.startsWith("---\n"), true);

        const resolved = await resolvePlan(cwd, "./outside.md");
        assertEquals(resolved.planName, "outside");
        assertEquals(resolved.attrs.origin, "external");

        await assertRejects(
            () => resolvePlan(cwd, "missing"),
            Error,
            "Plan not found: missing",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("worktree front matter fields round-trip and can be cleared", () => {
    const markdown = injectFrontMatter("## Body", {
        executionBaselineTree: "tree123",
        worktreeId: "wt-123",
        worktreePath: "/tmp/repo-runwield-plan-wt-123",
        worktreeBranch: "runwield/worktree/plan-wt-123",
        worktreeBaseBranch: "feature-base",
        worktreeStatus: "active",
    });

    const parsed = parsePlanFrontMatter(markdown);
    assertEquals(parsed.attrs.executionBaselineTree, "tree123");
    assertEquals(parsed.attrs.worktreeId, "wt-123");
    assertEquals(parsed.attrs.worktreePath, "/tmp/repo-runwield-plan-wt-123");
    assertEquals(parsed.attrs.worktreeBranch, "runwield/worktree/plan-wt-123");
    assertEquals(parsed.attrs.worktreeBaseBranch, "feature-base");
    assertEquals(parsed.attrs.worktreeStatus, "active");

    const cleared = injectFrontMatter(markdown, {
        worktreeId: null,
        worktreePath: null,
        worktreeBranch: null,
        worktreeBaseBranch: null,
        worktreeStatus: null,
    });
    const reparsed = parsePlanFrontMatter(cleared);
    assertEquals(reparsed.attrs.worktreeId, undefined);
    assertEquals(reparsed.attrs.worktreePath, undefined);
    assertEquals(reparsed.attrs.worktreeBranch, undefined);
    assertEquals(reparsed.attrs.worktreeBaseBranch, undefined);
    assertEquals(reparsed.attrs.worktreeStatus, undefined);
});

Deno.test("delivery evidence front matter validates compact shapes and rejects malformed values", () => {
    /** @type {import("./plan-store.js").DeliveryEvidence} */
    const worktreeEvidence = {
        version: 1,
        mode: "worktree_merge",
        executionCommit: "a".repeat(40),
        targetBranch: "main",
        targetHeadBeforeMerge: "b".repeat(40),
    };
    const markdown = injectFrontMatter("## Body", {
        executionMode: "worktree",
        deliveryEvidence: worktreeEvidence,
    });
    const parsed = parsePlanFrontMatter(markdown);
    assertEquals(parsed.attrs.executionMode, "worktree");
    assertEquals(parsed.attrs.deliveryEvidence, worktreeEvidence);

    const nonGit = parsePlanFrontMatter(injectFrontMatter("## Body", {
        executionMode: "non_git_in_place",
        deliveryEvidence: /** @type {any} */ ({
            version: 1,
            mode: "non_git_in_place",
            projectRoot: "/tmp/must-not-survive",
            validationCwd: "/tmp/must-not-survive",
            validatedAt: "2026-07-24T00:00:00.000Z",
        }),
    }));
    assertEquals(nonGit.attrs.deliveryEvidence, { version: 1, mode: "non_git_in_place" });

    const malformed = parsePlanFrontMatter(injectFrontMatter("## Body", {
        deliveryEvidence: /** @type {any} */ ({ version: 1, mode: "worktree_merge", executionCommit: "not-a-sha" }),
    }));
    assertEquals(malformed.attrs.deliveryEvidence, undefined);

    const partialSha = parsePlanFrontMatter(injectFrontMatter("## Body", {
        deliveryEvidence: /** @type {any} */ ({
            version: 1,
            mode: "worktree_merge",
            executionCommit: "a".repeat(39),
            targetBranch: "main",
            targetHeadBeforeMerge: "b".repeat(40),
        }),
    }));
    assertEquals(partialSha.attrs.deliveryEvidence, undefined);

    const cleared = parsePlanFrontMatter(injectFrontMatter(markdown, { deliveryEvidence: null, executionMode: null }));
    assertEquals(cleared.attrs.deliveryEvidence, undefined);
    assertEquals(cleared.attrs.executionMode, undefined);
});

Deno.test("Epic done-enough front matter fields round-trip and can be cleared", () => {
    const markdown = injectFrontMatter("## Body", {
        epicCompletionMode: "done_enough",
        epicDoneEnoughAt: "2026-06-17T00:00:00.000Z",
        epicDoneEnoughSummary: "1/2 features verified",
    });

    const parsed = parsePlanFrontMatter(markdown);
    assertEquals(parsed.attrs.epicCompletionMode, "done_enough");
    assertEquals(parsed.attrs.epicDoneEnoughAt, "2026-06-17T00:00:00.000Z");
    assertEquals(parsed.attrs.epicDoneEnoughSummary, "1/2 features verified");

    const cleared = injectFrontMatter(markdown, {
        epicCompletionMode: null,
        epicDoneEnoughAt: null,
        epicDoneEnoughSummary: null,
    });
    const reparsed = parsePlanFrontMatter(cleared);
    assertEquals(reparsed.attrs.epicCompletionMode, undefined);
    assertEquals(reparsed.attrs.epicDoneEnoughAt, undefined);
    assertEquals(reparsed.attrs.epicDoneEnoughSummary, undefined);
});

testWithFs("updatePlanFrontMatter preserves body and clears optional fields", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "front-matter", "## Body", {
            failureReason: "old failure",
            failedAt: "2026-06-14T00:00:00.000Z",
            status: "failed",
        });

        const attrs = await updatePlanFrontMatterForTest(cwd, "front-matter", {
            status: "implemented",
            failureReason: null,
            failedAt: null,
            implementedAt: "2026-06-15T00:00:00.000Z",
        });

        assertEquals(attrs.status, "implemented");
        assertEquals(attrs.failureReason, undefined);
        assertEquals(attrs.failedAt, undefined);
        assertEquals(attrs.implementedAt, "2026-06-15T00:00:00.000Z");

        const loaded = await loadPlan(cwd, "front-matter");
        assertEquals(loaded?.body.trim(), "## Body");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("updatePlanFrontMatter preserves exact body bytes", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await Deno.mkdir(join(cwd, "docs", "plans"), { recursive: true });
        const path = join(cwd, "docs", "plans", "byte-preserve.md");
        const body = "\n  # Body with leading whitespace\n\n\tIndented line\n";
        await Deno.writeTextFile(
            path,
            `---\nstatus: draft\nclassification: FEATURE\ncustomField: keep-me\n---\n${body}`,
        );

        await updatePlanFrontMatterForTest(cwd, "byte-preserve", { status: "approved" });
        const updated = await Deno.readTextFile(path);
        assertEquals(updated.slice(updated.indexOf("---\n", 4) + "---\n".length), body);
        assertEquals(
            /** @type {Record<string, unknown>} */ (parsePlanFrontMatter(updated).attrs).customField,
            "keep-me",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("updatePlanFrontMatter preserves and clears Delivery Evidence on partial updates", async () => {
    const cwd = await Deno.makeTempDir();
    /** @type {import("./plan-store.js").DeliveryEvidence} */
    const deliveryEvidence = {
        version: 1,
        mode: "worktree_merge",
        executionCommit: "a".repeat(40),
        targetBranch: "main",
        targetHeadBeforeMerge: "b".repeat(40),
    };
    try {
        await savePlan(cwd, "delivery", "## Body", {
            classification: "FEATURE",
            status: "verified",
            executionMode: "worktree",
            deliveryEvidence,
            summary: "Initial summary",
        });

        const partial = await updatePlanFrontMatterForTest(cwd, "delivery", { complexity: "HIGH" });
        assertEquals(partial.complexity, "HIGH");
        assertEquals(partial.executionMode, "worktree");
        assertEquals(partial.deliveryEvidence, deliveryEvidence);

        const reopened = await updatePlanFrontMatterForTest(cwd, "delivery", {
            status: "ready_for_work",
            deliveryEvidence: null,
            executionMode: null,
        });
        assertEquals(reopened.status, "ready_for_work");
        assertEquals(reopened.deliveryEvidence, undefined);
        assertEquals(reopened.executionMode, undefined);

        const loaded = await loadPlan(cwd, "delivery");
        assertEquals(loaded?.body.trim(), "## Body");
        assertEquals(loaded?.attrs.deliveryEvidence, undefined);
        assertEquals(loaded?.attrs.executionMode, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("classification updates reject preserved canonical execution policy on PROJECT Epics", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "feature-policy", "# Body", {
            classification: "FEATURE",
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
        });

        await assertRejects(
            () => updatePlanFrontMatterForTest(cwd, "feature-policy", { classification: "PROJECT" }),
            Error,
            "PROJECT Epics are non-executable and must not define executionAgent.",
        );
        const loaded = await loadPlan(cwd, "feature-policy");
        assertEquals(loaded?.attrs.classification, "PLANNED_CHANGE");
        assertEquals(loaded?.attrs.executionAgent, "frontend-engineer");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("lifecycle front matter updates preserve unchanged invalid raw policy values", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plansDir = `${cwd}/docs/plans`;
        await Deno.mkdir(plansDir, { recursive: true });
        await Deno.writeTextFile(
            `${plansDir}/invalid-policy.md`,
            [
                "---",
                "classification: FEATURE",
                "executionAgent: typo-agent",
                "collaborationRecommendation: 123",
                "status: draft",
                "---",
                "# Body",
                "",
            ].join("\n"),
        );

        await updatePlanStatusForTest(cwd, "invalid-policy", "approved");
        let loaded = await loadPlan(cwd, "invalid-policy");
        assertEquals(loaded?.attrs.status, "approved");
        assertEquals(loaded?.attrs.executionAgent, "typo-agent");
        assertEquals(loaded?.attrs.collaborationRecommendation, 123);

        await updatePlanFrontMatterForTest(cwd, "invalid-policy", { complexity: "HIGH" });
        loaded = await loadPlan(cwd, "invalid-policy");
        assertEquals(loaded?.attrs.complexity, "HIGH");
        assertEquals(loaded?.attrs.executionAgent, "typo-agent");
        assertEquals(loaded?.attrs.collaborationRecommendation, 123);

        await assertRejects(
            () => updatePlanFrontMatterForTest(cwd, "invalid-policy", { executionAgent: "unknown-owner" }),
            Error,
            "Invalid executionAgent: unknown-owner",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("updatePlanFrontMatter fails closed on malformed front matter", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plansDir = `${cwd}/docs/plans`;
        await Deno.mkdir(plansDir, { recursive: true });
        await Deno.writeTextFile(`${plansDir}/healed.md`, '---\nstatus: "bad\n---\n# Body');

        const malformed = await Deno.readTextFile(`${plansDir}/healed.md`);
        await assertRejects(
            () =>
                updatePlanFrontMatter(cwd, "healed", { status: "feedback" }, {
                    classification: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Recovered",
                    affectedPaths: ["src/a.js"],
                }),
            PlanFrontMatterParseError,
            "healed.md",
        );
        assertEquals(await Deno.readTextFile(`${plansDir}/healed.md`), malformed);

        await assertRejects(
            () => updatePlanFrontMatterForTest(cwd, "missing", { status: "draft" }),
            Error,
            "Plan not found: missing",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("parsePlanFrontMatter normalizes legacy and invalid statuses", () => {
    const completed = parsePlanFrontMatter([
        "---",
        'status: "completed"',
        "---",
        "body",
    ].join("\n"));
    assertEquals(completed.attrs.status, "verified");

    const inReview = parsePlanFrontMatter([
        "---",
        'status: "in_review"',
        "---",
        "body",
    ].join("\n"));
    assertEquals(inReview.attrs.status, "feedback");

    const readyForReview = parsePlanFrontMatter([
        "---",
        'status: "ready_for_review"',
        "---",
        "body",
    ].join("\n"));
    assertEquals(readyForReview.attrs.status, "implemented");

    const invalid = parsePlanFrontMatter([
        "---",
        'status: "whatever"',
        "---",
        "body",
    ].join("\n"));
    assertEquals(invalid.attrs.status, "draft");
});

Deno.test("planId front matter round-trips and blank values normalize away", () => {
    const markdown = injectFrontMatter("## Body", { planId: "plan-123" });
    const parsed = parsePlanFrontMatter(markdown);
    assertEquals(parsed.attrs.planId, "plan-123");
    assertEquals(markdown.includes('planId: "plan-123"'), true);

    assertEquals(parsePlanFrontMatter('---\nplanId: ""\n---\nBody').attrs.planId, undefined);
    assertEquals(parsePlanFrontMatter("---\nplanId: 123\n---\nBody").attrs.planId, undefined);
});

testWithFs("ensurePlanIdentity backfills missing planId while preserving body exactly", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "needs-id", "\n# Title\n\nBody with trailing spaces  \n\n", {
            summary: "Needs id",
            createdAt: "2026-06-24T00:00:00.000Z",
        });
        const before = await loadPlan(cwd, "needs-id");

        const resource = await ensurePlanIdentity(cwd, "needs-id", { idGenerator: () => "generated-id" });
        const after = await loadPlan(cwd, "needs-id");

        assertEquals(resource.planId, "generated-id");
        assertEquals(resource.planName, "needs-id");
        assertEquals(resource.relativePath, "docs/plans/needs-id.md");
        assertEquals(after?.attrs.planId, "generated-id");
        assertEquals(after?.body, before?.body);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("ensurePlanIdentity preserves existing planId", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "has-id", "# Body", { planId: "existing-id" });
        const before = await Deno.readTextFile(`${cwd}/docs/plans/has-id.md`);

        const resource = await ensurePlanIdentity(cwd, "has-id", { idGenerator: () => "new-id" });
        const after = await Deno.readTextFile(`${cwd}/docs/plans/has-id.md`);

        assertEquals(resource.planId, "existing-id");
        assertEquals(after, before);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("ensurePlanIdentity skips archived plans and does not backfill them", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "archived/old", "# Old");
        const before = await Deno.readTextFile(`${cwd}/docs/plans/archived/old.md`);

        await assertRejects(
            () => ensurePlanIdentity(cwd, "archived/old", { idGenerator: () => "archived-id" }),
            Error,
            "archived or hidden",
        );

        const after = await Deno.readTextFile(`${cwd}/docs/plans/archived/old.md`);
        assertEquals(after, before);
        assertEquals((await loadPlan(cwd, "archived/old"))?.attrs.planId, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("ensurePlanIdentity retries generated collisions and rejects duplicate existing planIds", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "existing", "# Existing", { planId: "existing-id" });
        await savePlan(cwd, "missing", "# Missing");
        const generatedIds = ["existing-id", "new-id"];

        const resource = await ensurePlanIdentity(cwd, "missing", {
            idGenerator: () => generatedIds.shift() || "unused",
        });

        assertEquals(resource.planId, "new-id");

        await savePlan(cwd, "duplicate", "# Duplicate", { planId: "existing-id" });
        await assertRejects(
            () => ensurePlanIdentity(cwd, "another-missing", { idGenerator: () => "another-id" }),
            Error,
            "Plan not found",
        );
        await assertRejects(
            () => ensurePlanIdentity(cwd, "missing", { idGenerator: () => "another-id" }),
            Error,
            "Duplicate planId",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("listPlanResources detects duplicate existing planIds before backfilling", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "a", "# A", { planId: "dup" });
        await savePlan(cwd, "b", "# B", { planId: "dup" });
        await savePlan(cwd, "missing", "# Missing");
        const before = await Deno.readTextFile(`${cwd}/docs/plans/missing.md`);

        await assertRejects(
            () => listPlanResources(cwd, { idGenerator: () => "should-not-write" }),
            Error,
            "Duplicate planId",
        );
        const after = await Deno.readTextFile(`${cwd}/docs/plans/missing.md`);
        assertEquals(after, before);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs(
    "listPlanResources backfills missing IDs, retries generated collisions, and hides archived plans",
    async () => {
        const cwd = await Deno.makeTempDir();
        try {
            await savePlan(cwd, "a", "# A", { planId: "existing" });
            await savePlan(cwd, "b", "# B");
            await savePlan(cwd, "archived/old", "# Old");
            const ids = ["existing", "generated"];

            const resources = await listPlanResources(cwd, {
                backfillMissing: true,
                idGenerator: () => ids.shift() || "unused",
            });

            assertEquals(resources.map((resource) => resource.name), ["a", "b"]);
            assertEquals(resources.map((resource) => resource.planId), ["existing", "generated"]);
            assertEquals((await loadPlan(cwd, "archived/old"))?.attrs.planId, undefined);
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
);

testWithFs("findPlanById resolves non-archived resources and reports unknown IDs", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "found", "# Found\n\n## Context\nFound plan\n\nBody", { planId: "lookup-id" });
        await savePlan(cwd, "archived/hidden", "# Hidden", { planId: "hidden-id" });

        const found = await findPlanById(cwd, "lookup-id");
        assertEquals(found.planName, "found");
        assertEquals(found.relativePath, "docs/plans/found.md");
        assertEquals(found.attrs.summary, "Found plan");
        assertEquals(found.body, "# Found\n\n## Context\nFound plan\n\nBody");
        assertEquals(found.markdown?.includes("lookup-id"), true);

        await assertRejects(() => findPlanById(cwd, "hidden-id"), Error, "Plan not found for planId");
        await assertRejects(() => findPlanById(cwd, "missing-id"), Error, "Plan not found for planId");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("shared hierarchy helpers match Epic, child, orphan, standalone, and progress semantics", () => {
    const plans = /** @type {any[]} */ ([
        { name: "epic", attrs: { classification: "PROJECT", status: "ready_for_work" } },
        { name: "epic/01-done", attrs: { classification: "FEATURE", parentPlan: "epic", status: "verified" } },
        { name: "epic/02-active", attrs: { classification: "FEATURE", parentPlan: "epic", status: "implemented" } },
        { name: "epic/03-failed", attrs: { classification: "FEATURE", parentPlan: "epic", status: "failed" } },
        { name: "epic/04-todo", attrs: { classification: "FEATURE", parentPlan: "epic", status: "draft" } },
        { name: "orphan/01-child", attrs: { classification: "FEATURE", parentPlan: "orphan", status: "draft" } },
        { name: "standalone", attrs: { classification: "FEATURE", status: "approved" } },
    ]);

    assertEquals(isEpicPlan(plans[0].attrs), true);
    assertEquals(isChildFeaturePlan(plans[1]), true);
    const grouped = groupPlanHierarchy(plans);
    assertEquals(grouped.epics.map((plan) => plan.name), ["epic"]);
    assertEquals((grouped.childrenByParent.get("epic") || []).map((plan) => plan.name), [
        "epic/01-done",
        "epic/02-active",
        "epic/03-failed",
        "epic/04-todo",
    ]);
    assertEquals(grouped.orphanChildren.map((plan) => plan.name), ["orphan/01-child"]);
    assertEquals(grouped.standalone.map((plan) => plan.name), ["standalone"]);
    assertEquals(countChildPlanProgress(grouped.childrenByParent.get("epic") || []), {
        verified: 1,
        userVerified: 0,
        completed: 1,
        active: 1,
        failed: 1,
        onHold: 0,
        remaining: 1,
        total: 4,
        byStatus: { verified: 1, implemented: 1, failed: 1, draft: 1 },
    });
});

Deno.test("resolveSiblingChildPlanDependencyStates exposes verified unverified and missing sibling states", () => {
    const siblings = /** @type {any[]} */ ([
        {
            name: "epic/01-done",
            planName: "epic/01-done",
            planId: "done-id",
            status: "validated",
            attrs: { status: "validated" },
        },
        {
            name: "epic/02-active",
            planName: "epic/02-active",
            planId: "active-id",
            status: "implemented",
            attrs: { status: "implemented" },
        },
        {
            name: "epic/03-user",
            planName: "epic/03-user",
            planId: "user-id",
            status: "user_verified",
            attrs: { status: "user_verified" },
        },
        {
            name: "epic/04-legacy",
            planName: "epic/04-legacy",
            planId: "legacy-id",
            status: "verified",
            attrs: { status: "verified" },
        },
    ]);

    assertEquals(
        resolveSiblingChildPlanDependencyStates(
            "epic",
            ["done", "epic/active", "user", "legacy", "05-missing"],
            siblings,
        ),
        [
            {
                dependency: "done",
                planId: "done-id",
                planName: "epic/01-done",
                path: undefined,
                status: "validated",
                state: "verified",
            },
            {
                dependency: "epic/active",
                planId: "active-id",
                planName: "epic/02-active",
                path: undefined,
                status: "implemented",
                state: "unverified",
            },
            {
                dependency: "user",
                planId: "user-id",
                planName: "epic/03-user",
                path: undefined,
                status: "user_verified",
                state: "user_verified",
            },
            {
                dependency: "legacy",
                planId: "legacy-id",
                planName: "epic/04-legacy",
                path: undefined,
                status: "verified",
                state: "verified",
            },
            { dependency: "05-missing", state: "missing" },
        ],
    );
});

function lockedPlanFrontMatter(overrides = {}) {
    return {
        collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
        collaborationServerUrl: "https://plans.example.test/base",
        collaborationSpaceId: "space-1",
        collaborationRevision: 7,
        collaborationBodyHash: "previous-body-hash",
        collaborationSyncedAt: "2026-07-04T00:00:00.000Z",
        ...overrides,
    };
}

testWithFs("collaboration front matter formats and parses non-secret metadata", async () => {
    await Promise.resolve();
    const markdown = injectFrontMatter(
        "## Plan\n\nBody",
        lockedPlanFrontMatter({
            collaborationServerUrl: "https://plans.example.test/base/",
            collaborationRevision: "8",
        }),
    );
    const { attrs } = parsePlanFrontMatter(markdown);

    assertEquals(attrs.collaborationState, COLLABORATION_STATE_REMOTE_CANONICAL);
    assertEquals(attrs.collaborationServerUrl, "https://plans.example.test/base");
    assertEquals(attrs.collaborationSpaceId, "space-1");
    assertEquals(attrs.collaborationRevision, 8);
    assertEquals(markdown.includes("contentKey"), false);
    assertEquals(markdown.includes("bearerCapability"), false);
    assertEquals(markdown.includes("reviewerUrl"), false);
});

testWithFs("locked shared plans reject normal save/status/front matter/body writes without mutation", async () => {
    const cwd = await Deno.makeTempDir();
    const path = await savePlan(cwd, "locked", "## Plan\n\nOriginal", lockedPlanFrontMatter());
    const before = await Deno.readTextFile(path);

    await assertRejects(() => savePlan(cwd, "locked", "## Plan\n\nChanged"), SharedPlanLockError);
    await assertRejects(() => updatePlanStatusForTest(cwd, "locked", "approved"), SharedPlanLockError);
    await assertRejects(() => updatePlanFrontMatterForTest(cwd, "locked", { summary: "Changed" }), SharedPlanLockError);

    await Deno.writeTextFile(
        path,
        injectFrontMatter("## Plan\n\nOriginal", { ...lockedPlanFrontMatter(), planId: "plan-1" }),
    );
    const bodyResource = await loadPlanBodyById(cwd, "plan-1");
    await assertRejects(
        () => savePlanBodyByIdForTest(cwd, "plan-1", "## Plan\n\nChanged", bodyResource.bodyHash),
        SharedPlanLockError,
    );
    assertEquals((await Deno.readTextFile(path)).includes("Changed"), false);
    assertEquals(before.includes("collaborationBodyHash:"), false);
    assertEquals(
        (await readControllerRecord(cwd, { planName: "locked", planId: "plan-1" }))?.state.collaborationBodyHash,
        "previous-body-hash",
    );
});

testWithFs("locked shared plan writes require exact collaboration bypass", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "locked", "## Plan\n\nOriginal", lockedPlanFrontMatter());
    await assertRejects(
        () => savePlan(cwd, "locked", "## Plan\n\nChanged", {}, { collaborationLockBypass: /** @type {any} */ (true) }),
        SharedPlanLockError,
    );
    const before = await loadPlan(cwd, "locked");
    if (!before) throw new Error("Expected locked Plan to exist");
    await savePlan(cwd, "locked", "## Plan\n\nChanged", {}, {
        collaborationLockBypass: COLLABORATION_LOCK_BYPASS.pull,
        expectedRevision: before.revision,
    });
    const loaded = await loadPlan(cwd, "locked");
    if (!loaded) throw new Error("Expected locked Plan to exist");
    assertStringIncludes(loaded.body, "Changed");
});

testWithFs("malformed remote-canonical front matter variants reject recovery writes without mutation", async () => {
    const cwd = await Deno.makeTempDir();
    const dir = await ensurePlansDir(cwd);
    const path = `${dir}/malformed.md`;
    const malformed = [
        "---",
        "collaborationState : remote_canonical # locked on the Plan Server",
        "classification: [",
        "---",
        "## Plan",
        "",
        "Original",
    ].join("\n");
    await Deno.writeTextFile(path, malformed);

    await assertRejects(() => updatePlanStatusForTest(cwd, "malformed", "approved"), PlanFrontMatterParseError);
    await assertRejects(
        () => updatePlanFrontMatterForTest(cwd, "malformed", { summary: "Changed" }),
        PlanFrontMatterParseError,
    );
    assertEquals(await Deno.readTextFile(path), malformed);
});

testWithFs("saveChildFeaturePlans rejects stale expected child revisions", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await saveChildFeaturePlans(cwd, "epic", [{
            title: "Child",
            order: 1,
            summary: "Original",
            affectedPaths: [],
            dependencies: [],
            content: "# Original",
        }]);
        const child = await loadPlan(cwd, "epic/01-child");
        await updatePlanFrontMatterForTest(cwd, "epic/01-child", { complexity: "HIGH" });
        await assertRejects(
            () =>
                saveChildFeaturePlans(cwd, "epic", [{
                    title: "Child",
                    order: 1,
                    summary: "Overwrite attempt",
                    affectedPaths: [],
                    dependencies: [],
                    content: "# Overwrite",
                }], { expectedRevisions: { "epic/01-child": child?.revision || "missing" } }),
            StalePlanWriteError,
        );
        assertEquals((await loadPlan(cwd, "epic/01-child"))?.attrs.complexity, "HIGH");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("saveChildFeaturePlans rejects overwriting locked child plans", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "epic/01-child", "## Child\n\nOriginal", lockedPlanFrontMatter());
    await assertRejects(
        () =>
            saveChildFeaturePlans(cwd, "epic", [{
                title: "Child",
                summary: "Changed",
                affectedPaths: [],
                dependencies: [],
                content: "## Child\n\nChanged",
                order: 1,
            }]),
        SharedPlanLockError,
    );
    const loaded = await loadPlan(cwd, "epic/01-child");
    if (!loaded) throw new Error("Expected child Plan to exist");
    assertStringIncludes(loaded.body, "Original");
});

testWithFs(
    "createPulledCollaborationPlan creates locked plan and auto-suffixes generated name collisions",
    async () => {
        const cwd = await Deno.makeTempDir();
        await savePlan(cwd, "remote-title", "## Existing\n\nBody", { planId: "other-plan" });
        const created = await createPulledCollaborationPlan(cwd, {
            title: "Remote Title",
            body: "## Remote\n\nBody",
            attrs: {
                planId: "plan-remote",
                classification: "FEATURE",
                complexity: "MEDIUM",
                summary: "Remote Title",
                status: "draft",
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: "https://plans.example",
                collaborationSpaceId: "space-1",
                collaborationRevision: 2,
                collaborationBodyHash: await hashPlanBody("## Remote\n\nBody"),
            },
        });

        assertEquals(created.planName, "remote-title-2");
        assertEquals(created.attrs.planId, "plan-remote");
        assertEquals(created.attrs.collaborationState, COLLABORATION_STATE_REMOTE_CANONICAL);
        assertEquals(created.attrs.collaborationRevision, 2);
    },
);

testWithFs("createPulledCollaborationPlan rejects explicit destination collisions", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "copy/review", "## Existing\n\nBody", { planId: "other-plan" });
    await assertRejects(
        () =>
            createPulledCollaborationPlan(cwd, {
                preferredName: "copy/review",
                body: "## Remote\n\nBody",
                attrs: { planId: "plan-remote" },
            }),
        Error,
        "Plan already exists",
    );
});

testWithFs("updatePlanCollaborationMetadata intentionally refreshes controlled body hash", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "locked", "## Plan\n\nOriginal", lockedPlanFrontMatter());
    const attrs = await updatePlanCollaborationMetadata(
        cwd,
        "locked",
        { collaborationRevision: 8 },
        COLLABORATION_LOCK_BYPASS.pull,
        { body: "## Plan\n\nChanged" },
    );
    assertEquals(attrs.collaborationRevision, 8);
    assertEquals(attrs.collaborationBodyHash, await hashPlanBody("## Plan\n\nChanged"));
    const loaded = await loadPlan(cwd, "locked");
    if (!loaded) throw new Error("Expected locked Plan to exist");
    assertStringIncludes(loaded.body, "Changed");
});

testWithFs("updatePlanCollaborationMetadata applies decrypted plan front matter", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(
        cwd,
        "locked",
        "## Plan\n\nOriginal",
        lockedPlanFrontMatter({ classification: "FEATURE", summary: "Old summary", status: "draft" }),
    );
    const attrs = await updatePlanCollaborationMetadata(
        cwd,
        "locked",
        {
            classification: "PROJECT",
            summary: "Remote summary",
            status: "approved",
            affectedPaths: ["src/remote.js"],
            collaborationRevision: 8,
        },
        COLLABORATION_LOCK_BYPASS.pull,
        { body: "## Context\n\nRemote summary" },
    );

    assertEquals(attrs.classification, "PROJECT");
    assertEquals(attrs.summary, "Remote summary");
    assertEquals(attrs.status, "approved");
    assertEquals(attrs.affectedPaths, ["src/remote.js"]);
    assertEquals(attrs.collaborationRevision, 8);
});

testWithFs("updatePlanCollaborationMetadata preserves body hash without controlled body write", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "locked", "## Plan\n\nOriginal", lockedPlanFrontMatter());
    const attrs = await updatePlanCollaborationMetadata(
        cwd,
        "locked",
        { collaborationRevision: 8, collaborationBodyHash: "untrusted-new-hash" },
        COLLABORATION_LOCK_BYPASS.pull,
    );
    assertEquals(attrs.collaborationRevision, 8);
    assertEquals(attrs.collaborationBodyHash, "previous-body-hash");
});

testWithFs("updatePlanCollaborationMetadata filters non-front-matter collaboration secrets", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(
        cwd,
        "locked",
        "## Plan\n\nOriginal",
        /** @type {any} */ ({
            ...lockedPlanFrontMatter(),
            bearerCapability: "bearer-secret",
            contentKey: "content-key-secret",
            reviewerUrl: "https://plans.example.test/p/space-1#contentKey=secret",
        }),
    );
    const attrs = await updatePlanCollaborationMetadata(
        cwd,
        "locked",
        /** @type {any} */ ({
            bearerCapability: "new-bearer-secret",
            collaborationRevision: 8,
            collaborationServerUrl: "https://plans.example.test/base#contentKey=secret",
            contentKey: "new-content-key-secret",
            reviewerUrl: "https://plans.example.test/p/space-1#contentKey=new-secret",
        }),
        COLLABORATION_LOCK_BYPASS.pull,
    );
    const loaded = await loadPlan(cwd, "locked");
    if (!loaded) throw new Error("Expected locked Plan to exist");
    const markdown = await Deno.readTextFile(loaded.path);

    assertEquals(attrs.collaborationRevision, 8);
    assertEquals(attrs.collaborationServerUrl, "https://plans.example.test/base");
    assertEquals(markdown.includes("bearerCapability"), false);
    assertEquals(markdown.includes("contentKey"), false);
    assertEquals(markdown.includes("reviewerUrl"), false);
    assertEquals(markdown.includes("secret"), false);
});

testWithFs("clearPlanCollaborationMetadata removes lock metadata and preserves body and normal metadata", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(
        cwd,
        "locked",
        "## Plan\n\n## Context\nKeep me\n\nOriginal body",
        lockedPlanFrontMatter({ status: "approved", summary: "Keep me", planId: "plan-1" }),
    );

    const attrs = await clearPlanCollaborationMetadata(
        cwd,
        "locked",
        COLLABORATION_LOCK_BYPASS.unshare,
        { updatedAt: "2026-07-04T12:00:00.000Z" },
    );
    const loaded = await loadPlan(cwd, "locked");
    if (!loaded) throw new Error("Expected locked Plan to exist");
    const markdown = await Deno.readTextFile(loaded.path);

    assertEquals(attrs.planId, "plan-1");
    assertEquals(attrs.status, "approved");
    assertEquals(attrs.summary, "Keep me");
    assertEquals(attrs.updatedAt, "2026-07-04T12:00:00.000Z");
    assertEquals(attrs.collaborationState, undefined);
    assertEquals(attrs.collaborationServerUrl, undefined);
    assertEquals(attrs.collaborationSpaceId, undefined);
    assertEquals(attrs.collaborationRevision, undefined);
    assertEquals(attrs.collaborationBodyHash, undefined);
    assertEquals(attrs.collaborationSyncedAt, undefined);
    assertStringIncludes(loaded.body, "Original body");
    assertEquals(markdown.includes("collaborationState"), false);
});

testWithFs("clearPlanCollaborationMetadata requires exact unshare bypass", async () => {
    const cwd = await Deno.makeTempDir();
    await savePlan(cwd, "locked", "## Plan\n\nOriginal", lockedPlanFrontMatter());

    await assertRejects(
        () => clearPlanCollaborationMetadata(cwd, "locked", COLLABORATION_LOCK_BYPASS.pull),
        Error,
        "unshare collaboration lock bypass",
    );
});

testWithFs("supersedes survives Plan revisions and archival", async () => {
    const cwd = await Deno.makeTempDir();
    const recordA = "550e8400-e29b-41d4-a716-446655440000";
    const recordB = "550e8400-e29b-41d4-a716-446655440001";
    try {
        await savePlan(cwd, "superseding-plan", "# Superseding Plan", {
            planId: "superseding-plan-id",
            status: "draft",
            supersedes: [` ${recordA} `, recordA, recordB],
        });

        const revised = await updatePlanFrontMatterForTest(cwd, "superseding-plan", { status: "verified" });
        assertEquals(revised.supersedes, [recordA, recordB]);

        await archivePlan(cwd, "superseding-plan", { now: "2026-07-15T00:00:00.000Z" });
        const archived = await loadArchivedPlan(cwd, "superseding-plan");
        assertEquals(archived?.attrs.supersedes, [recordA, recordB]);
        assertEquals(archived?.attrs.archivedAt, "2026-07-15T00:00:00.000Z");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("updateArchivedPlanFrontMatter preserves archive metadata while adding Work Record backlink", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "archived-link", "# Archived Link\n\n## Plan\n\nBody", {
            planId: "plan-archived-link",
            classification: "FEATURE",
            complexity: "LOW",
            summary: "Archived link.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        await archivePlan(cwd, "archived-link", {
            now: "2026-07-15T00:00:00.000Z",
            reason: "complete",
        });

        const attrs = await updateArchivedPlanFrontMatter(cwd, "archived-link", {
            workRecord: {
                status: "generated",
                recordId: "11111111-1111-4111-8111-111111111111",
                path: "docs/work-records/archived-link.md",
                lastAttemptAt: "2026-07-16T00:00:00.000Z",
            },
            updatedAt: "2026-07-16T00:00:00.000Z",
        });
        const loaded = await loadArchivedPlan(cwd, "archived-link");

        assertEquals(attrs.workRecord?.recordId, "11111111-1111-4111-8111-111111111111");
        assertEquals(loaded?.attrs.archivedAt, "2026-07-15T00:00:00.000Z");
        assertEquals(loaded?.attrs.archiveReason, "complete");
        assertEquals(loaded?.attrs.workRecord?.status, "generated");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("Plan front matter normalizes and preserves Ticket References", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "ticketed", "# Ticketed", {
            summary: "Ticketed",
            tickets: [
                { url: " https://example.com/tickets/ABC-123 ", label: "ABC", count: 1 },
                { url: "" },
                /** @type {any} */ ("https://example.com/not-an-object"),
            ],
        });
        const loaded = await loadPlan(cwd, "ticketed");
        assertEquals(loaded?.attrs.tickets, [{ url: "https://example.com/tickets/ABC-123", label: "ABC", count: 1 }]);
        assertStringIncludes(loaded?.markdown || "", 'tickets:\n  - url: "https://example.com/tickets/ABC-123"');

        const updated = await updatePlanFrontMatterForTest(cwd, "ticketed", { status: "approved" });
        assertEquals(updated.tickets, [{ url: "https://example.com/tickets/ABC-123", label: "ABC", count: 1 }]);
        const cleared = await updatePlanFrontMatterForTest(cwd, "ticketed", { tickets: [] });
        assertEquals(cleared.tickets, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs(
    "child plan materialization preserves omitted Ticket References and clears explicit empty references",
    async () => {
        const cwd = await Deno.makeTempDir();
        try {
            await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "approved" });
            await saveChildFeaturePlans(cwd, "epic", [{
                title: "Child",
                order: 1,
                summary: "Child",
                affectedPaths: [],
                dependencies: [],
                tickets: [{ url: "https://example.com/tickets/CHILD-1" }],
                content: "# Child",
            }]);
            await saveChildFeaturePlans(cwd, "epic", [{
                title: "Child",
                order: 1,
                summary: "Updated",
                affectedPaths: [],
                dependencies: [],
                content: "# Child updated",
            }]);
            assertEquals((await loadPlan(cwd, "epic/01-child"))?.attrs.tickets, [{
                url: "https://example.com/tickets/CHILD-1",
            }]);
            await saveChildFeaturePlans(cwd, "epic", [{
                title: "Child",
                order: 1,
                summary: "Cleared",
                affectedPaths: [],
                dependencies: [],
                tickets: [],
                content: "# Child cleared",
            }]);
            assertEquals((await loadPlan(cwd, "epic/01-child"))?.attrs.tickets, undefined);
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
);

testWithFs("listPlans fails closed for non-regular markdown Plan paths", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plansDir = await ensurePlansDir(cwd);
        await Deno.mkdir(join(plansDir, "dir-plan.md"));
        await assertRejects(() => listPlans(cwd), Error, "not a markdown file");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("listPlans fails closed for symlink markdown Plan paths", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        const plansDir = await ensurePlansDir(cwd);
        const target = join(cwd, "external.md");
        await Deno.writeTextFile(target, "# External");
        await Deno.symlink(target, join(plansDir, "linked.md"));
        await assertRejects(() => listPlans(cwd), Error, "not a regular markdown file");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("withPlanLock serializes concurrent same-process tasks while allowing nested reentry", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        /** @type {string[]} */
        const events = [];
        /** @type {() => void} */
        let releaseFirst = () => {};
        const firstMayFinish = new Promise((resolve) => {
            releaseFirst = () => resolve(null);
        });
        const resolvedCwd = Deno.realPathSync(cwd);
        const lockPath = join(
            getRunWieldRuntimeDir(resolvedCwd),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            "plan-locks",
            "demo.lock",
        );
        const legacyLockPath = join(getRunWieldRuntimeDir(resolvedCwd), "plan-locks", "demo.lock");
        const catalogPath = join(
            getRunWieldRuntimeDir(resolvedCwd),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            "plan-locks",
            "catalog.lock",
        );
        const firstEntered = new Promise((resolve) => {
            void withPlanLock(cwd, "demo", async () => {
                events.push("first-enter");
                await Deno.lstat(lockPath);
                await assertMissing(legacyLockPath);
                await withPlanCatalogLock(cwd, async () => {
                    await Deno.lstat(catalogPath);
                });
                await withPlanLock(cwd, "demo", () => {
                    events.push("nested-enter");
                    return Promise.resolve();
                });
                resolve(null);
                await firstMayFinish;
                events.push("first-exit");
            });
        });
        await firstEntered;
        await assertMissing(catalogPath);
        const second = withPlanLock(cwd, "demo", () => {
            events.push("second-enter");
            return Promise.resolve();
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        assertEquals(events, ["first-enter", "nested-enter"]);
        releaseFirst();
        await second;
        assertEquals(events, ["first-enter", "nested-enter", "first-exit", "second-enter"]);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("a plain markdown file in docs/plans/ is readable and is never claimed by a passive read", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-external-plan-" });
    try {
        const bare = "# Random notes\n\nI wrote this in vim.\n";
        await Deno.mkdir(join(cwd, "docs", "plans"), { recursive: true });
        const path = join(cwd, "docs", "plans", "random.md");
        await Deno.writeTextFile(path, bare);

        // Reads must tolerate the missing Front Matter rather than panic.
        const loaded = await loadPlan(cwd, "random");
        assertEquals(loaded?.attrs.status, "draft", "parsing falls back to defaults");
        assertEquals(loaded?.hasFrontMatter, false, "but the file's un-onboarded state stays visible");
        assertEquals((await listPlans(cwd)).map((plan) => plan.name), ["random"]);

        // Listing is not consent. Backfilling identity here would let opening a Plan
        // Board or reading the worktree registry stamp metadata into the user's file.
        const resources = await listPlanResources(cwd);
        assertEquals(resources.map((resource) => resource.name), ["random"]);
        assertEquals(resources[0].planId, "", "no identity is invented for an un-onboarded file");
        assertEquals(await Deno.readTextFile(path), bare, "the user's file is byte-for-byte untouched");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("onboardExternalPlan adopts a plain markdown Plan and preserves the body exactly", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-onboard-plan-" });
    try {
        const bare = "# Old plan\n\nProse the user wrote, with `---` inside it.\n";
        await Deno.mkdir(join(cwd, "docs", "plans"), { recursive: true });
        const path = join(cwd, "docs", "plans", "old.md");
        await Deno.writeTextFile(path, bare);
        // A Plan that has existed for weeks before RunWield saw it.
        const past = new Date("2026-06-01T12:00:00.000Z");
        await Deno.utime(path, past, past);
        const createdBefore = (await Deno.stat(path)).birthtime;

        const adopted = await onboardExternalPlan(cwd, "old", { now: () => new Date("2026-07-01T00:00:00.000Z") });
        assertEquals(adopted.onboarded, true);

        const attrs = parsePlanFrontMatter(await Deno.readTextFile(path)).attrs;
        assertEquals(attrs.classification, "PLANNED_CHANGE");
        assertEquals(attrs.status, "draft");
        assertEquals(attrs.origin, "external");
        assertEquals(attrs.complexity, "MEDIUM");
        assertEquals(attrs.summary, "");
        assertEquals(attrs.affectedPaths, []);
        assertEquals(attrs.workKind, undefined, "work kind is unknown until someone decides it");
        assertEquals(attrs.updatedAt, undefined, "runtime timestamps are not copied into the Plan");
        assertEquals(adopted.resource.attrs.updatedAt, "2026-07-01T00:00:00.000Z");
        assertEquals(Boolean(attrs.planId), true, "onboarding gives the Plan a durable identity");
        // The atomic rename resets the file's birthtime, so the Plan's real age only
        // survives because it was captured before the write.
        assertEquals(attrs.createdAt, createdBefore?.toISOString());
        assertEquals(parsePlanFrontMatter(await Deno.readTextFile(path)).body, bare, "the body is untouched");

        // Idempotent: loading a Plan twice must not rewrite metadata the lifecycle set.
        const onboarded = await loadPlan(cwd, "old");
        await updatePlanFrontMatter(cwd, "old", { status: "approved" }, {}, {
            expectedRevision: onboarded?.revision,
        });
        const again = await onboardExternalPlan(cwd, "old");
        assertEquals(again.onboarded, false);
        assertEquals(again.resource.planId, adopted.resource.planId, "identity is stable");
        assertEquals((await loadPlan(cwd, "old"))?.attrs.status, "approved", "lifecycle state is not reset");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("a Plan lock left by a dead process is reclaimed immediately", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-dead-lock-" });
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "draft", classification: "FEATURE" });
        const resolvedCwd = Deno.realPathSync(cwd);
        const lockDir = join(getRunWieldRuntimeDir(resolvedCwd), PROJECT_INTERNAL_RUNTIME_DIR_NAME, "plan-locks");
        const lockPath = join(lockDir, "demo.lock");
        const legacyLockPath = join(getRunWieldRuntimeDir(resolvedCwd), "plan-locks", "demo.lock");
        await Deno.mkdir(lockDir, { recursive: true });
        // A lock naming this host and a pid that is definitely gone. Waiting for it to
        // look old enough would block every operation on this Plan for the whole stale
        // window, which is RunWield's bookkeeping locking the user out of their Plan.
        await Deno.writeTextFile(
            lockPath,
            JSON.stringify({ pid: 2147483646, hostname: Deno.hostname(), updatedAtMs: Date.now() }),
        );

        const started = Date.now();
        const held = await withPlanLock(cwd, "demo", () => Promise.resolve("acquired"));
        assertEquals(held, "acquired");
        assertEquals(
            Date.now() - started < 5_000,
            true,
            "a dead holder must be reclaimed at once, not waited out",
        );
        await assertMissing(lockPath);
        await assertMissing(legacyLockPath);
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

testWithFs("listPlanResources does not write Plan files unless backfill is requested", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-plan-resources-readonly-" });
    try {
        await savePlan(cwd, "no-id", "# No Id\n", {
            classification: "FEATURE",
            status: "ready_for_work",
            summary: "s",
            affectedPaths: [],
        });
        const before = await loadPlan(cwd, "no-id");

        // A read must stay a read: registry reads and Workspace listings run this
        // from inside lifecycle transactions, and a silent Front Matter write there
        // rewrites bytes the transaction already snapshotted.
        const listed = await listPlanResources(cwd);
        assertEquals(listed.length, 1);
        assertEquals(listed[0].planId, "");
        assertEquals((await loadPlan(cwd, "no-id"))?.revision, before?.revision);

        const healed = await listPlanResources(cwd, { backfillMissing: true, idGenerator: () => "minted-id" });
        assertEquals(healed[0].planId, "minted-id");
        assertEquals((await loadPlan(cwd, "no-id"))?.attrs.planId, "minted-id");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("legacy plans/ files are ignored, not migrated or accepted", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-legacy-plans-ignored-" });
    try {
        // A project that only has the old store location. This is the clean-break
        // contract: the legacy directory is neither scanned nor readable.
        await Deno.mkdir(join(cwd, "plans"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "plans", "legacy.md"), "# Legacy\n");
        assertEquals(await listPlans(cwd), [], "legacy plans/ files are not listed");
        assertEquals(await loadPlan(cwd, "legacy"), null, "legacy plans/ files cannot be loaded by name");
        assertEquals(await resolvePlan(cwd, "legacy").catch(() => null), null, "legacy name resolves to nothing");
        await assertRejects(
            () => resolvePlan(cwd, "plans/legacy.md"),
            Error,
            "Legacy Plan path is not supported: plans/legacy.md",
        );
        await assertRejects(
            () => resolvePlan(cwd, join(cwd, "plans", "legacy.md")),
            Error,
            "Legacy Plan path is not supported: plans/legacy.md",
        );
        assertEquals(await listArchivedPlans(cwd), [], "plans/archived/ is not scanned either");

        // The same content under the canonical store is listed and loaded.
        await Deno.mkdir(join(cwd, "docs", "plans"), { recursive: true });
        const currentMarkdown = injectFrontMatter("# Current\n", { planId: "current-1" });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "current.md"), currentMarkdown);
        const listed = await listPlans(cwd);
        assertEquals(listed.map((plan) => plan.name), ["current"]);
        const loaded = await loadPlan(cwd, "current");
        assertEquals(loaded?.attrs.planId, "current-1");
        // The canonical store path prefix resolves to the same file.
        assertEquals((await loadPlan(cwd, "docs/plans/current.md"))?.attrs.planId, "current-1");
    } finally {
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

testWithFs("manual-qa Epic Artifact is excluded from Plan loading and listing", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-store-epic-artifact-" });
    try {
        await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "ready_for_work" });
        await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), "not front matter");

        assertEquals(await loadPlan(cwd, "epic/manual-qa"), null);
        assertEquals(await loadPlan(cwd, "docs/plans/epic/manual-qa.md"), null);
        assertEquals((await loadPlanStrict(cwd, "epic/manual-qa")).kind, "not_found");
        assertEquals((await loadPlanStrict(cwd, "docs/plans/epic/manual-qa.md")).kind, "not_found");
        assertEquals((await listPlans(cwd)).some((plan) => plan.name === "epic/manual-qa"), false);

        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "notes.md"), "not front matter");
        assertEquals((await listPlans(cwd)).some((plan) => plan.name === "epic/notes"), true);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("reserved manual-qa child Plan writes are rejected", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-store-reserved-artifact-" });
    try {
        await assertRejects(
            () => savePlan(cwd, "epic/manual-qa", "# Manual QA", { classification: "PLANNED_CHANGE" }),
            Error,
            "reserved for an Epic Artifact",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archive and restore move Epic manual-qa artifact bytes", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-store-artifact-archive-" });
    try {
        const artifactText = "# QA\n\n- [ ] Check\n";
        await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
        await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), artifactText);

        const archived = await archivePlan(cwd, "epic");
        assertEquals(archived.artifacts?.[0].relativePath, "docs/plans/archived/epic/manual-qa.md");
        assertEquals(
            await Deno.readTextFile(join(cwd, "docs", "plans", "archived", "epic", "manual-qa.md")),
            artifactText,
        );
        await assertRejects(() => Deno.stat(join(cwd, "docs", "plans", "epic", "manual-qa.md")), Deno.errors.NotFound);

        const restored = await restoreArchivedPlan(cwd, "epic");
        assertEquals(restored.artifacts?.[0].relativePath, "docs/plans/epic/manual-qa.md");
        assertEquals(await Deno.readTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md")), artifactText);
        await assertRejects(
            () => Deno.stat(join(cwd, "docs", "plans", "archived", "epic", "manual-qa.md")),
            Deno.errors.NotFound,
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("archive rolls back the archived Plan file when Epic Artifact movement collides", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-store-artifact-archive-collision-" });
    try {
        await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
        await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await Deno.mkdir(join(cwd, "docs", "plans", "archived", "epic"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), "active artifact");
        await Deno.writeTextFile(join(cwd, "docs", "plans", "archived", "epic", "manual-qa.md"), "archived artifact");

        await assertRejects(() => archivePlan(cwd, "epic"), Error, "Epic Artifact already exists");

        assertEquals((await loadPlan(cwd, "epic"))?.attrs.classification, "PROJECT");
        assertEquals(await loadArchivedPlan(cwd, "epic"), null);
        assertEquals(await Deno.readTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md")), "active artifact");
        assertEquals(
            await Deno.readTextFile(join(cwd, "docs", "plans", "archived", "epic", "manual-qa.md")),
            "archived artifact",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

testWithFs("restore rolls back the active Plan file when Epic Artifact movement collides", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-store-artifact-restore-collision-" });
    try {
        await savePlan(cwd, "epic", "# Epic", { classification: "PROJECT", status: "verified" });
        await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), "archived artifact");
        await archivePlan(cwd, "epic");
        await Deno.mkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await Deno.writeTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), "active artifact");

        await assertRejects(() => restoreArchivedPlan(cwd, "epic"), Error, "Epic Artifact already exists");

        assertEquals(await loadPlan(cwd, "epic"), null);
        assertEquals((await loadArchivedPlan(cwd, "epic"))?.name, "epic");
        assertEquals(await Deno.readTextFile(join(cwd, "docs", "plans", "epic", "manual-qa.md")), "active artifact");
        assertEquals(
            await Deno.readTextFile(join(cwd, "docs", "plans", "archived", "epic", "manual-qa.md")),
            "archived artifact",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("legacy done-enough Epic remains deliberately closed without invented verification", async () => {
    const root = await Deno.makeTempDir({ prefix: "legacy-epic-closure-" });
    try {
        await savePlan(root, "legacy-epic", "# Legacy Epic", {
            classification: "PROJECT",
            status: "validated",
            epicCompletionMode: "done_enough",
            epicDoneEnoughAt: "2026-01-01T00:00:00.000Z",
            validatedAt: "2026-01-01T00:00:00.000Z",
        });
        const plan = await loadPlan(root, "legacy-epic");
        assertEquals(plan?.attrs.status, "closed_without_verification");
        assertEquals(Boolean(plan?.attrs.verifiedAt), false);
        const inspected = await inspectPlanFileStrict(join(root, "docs/plans/legacy-epic.md"));
        assert(inspected.kind === "loaded");
        assertEquals(inspected.attrs.status, "closed_without_verification");
        assertEquals((await listPlans(root))[0].attrs.status, "closed_without_verification");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
