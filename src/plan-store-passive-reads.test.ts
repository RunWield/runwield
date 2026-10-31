import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects, throws, ok } from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import { withProcessGlobalTestLock } from "./testing/process-global-lock.ts";
import { dirname, join } from "node:path";
import {
    findPlanById,
    getPlanDocumentRoot,
    listPlanResources,
    listArchivedPlans,
    loadArchivedPlan,
    listPlans,
    loadPlan,
    loadPlanBodyById,
    parsePlanTextStrict,
} from "./plan-store.js";
import { getRunWieldRuntimeDir } from "./constants.js";
import { defineGitFixture, git } from "./shared/git-test-fixture.ts";
import {
    enterProjectRuntime,
    ProjectRuntimeEntryRefusedError,
    WORKFLOW_DETAILS_PENDING,
} from "./shared/project-runtime-layout.ts";
import { writeControllerState } from "./shared/workflow/controller-registry.ts";
import { loadTargetPlan } from "./shared/workflow/planning-worktree.ts";

function document(id: string, extra = "", body = "# Plan\n\nRésumé 世界 🧭\n") {
    return `---\n${id ? `planId: ${id}\n` : ""}classification: FEATURE\nstatus: ready_for_work\n${extra}---\n${body}`;
}

async function writeDocument(root: string, name: string, markdown: string) {
    const path = join(root, "docs/plans", `${name}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
    return path;
}

// Include Git storage and sandboxed runtime storage, not just document bytes.
async function tree(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            result[`${entry.name}/`] = "directory";
            for (const [child, bytes] of Object.entries(await tree(path))) result[`${entry.name}/${child}`] = bytes;
        } else if (entry.isFile()) result[entry.name] = (await readFile(path)).toString("base64");
    }
    return result;
}

async function snapshot(root: string) {
    return { project: await tree(root), runtime: await tree(getRunWieldRuntimeDir(root)) };
}

const fixture = defineGitFixture(async (root) => {
    await writeDocument(root, "ordinary", document("ordinary-id"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["switch", "-c", "target"]);
    await writeDocument(root, "epic/01-child", document("child-id", "parentPlan: epic\norder: 1\n"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "target child"]);
    await git(root, ["switch", "main"]);
    await writeDocument(
        root,
        "epic",
        "---\nplanId: epic-id\nclassification: PROJECT\ntargetBranch: target\n---\n# Epic\n",
    );
});

test("fresh catalog retains missing identities with a pending notice and creates no runtime", async () => {
    const root = await fixture.checkout();
    try {
        await writeDocument(root, "unadopted", document(""));
        const before = await snapshot(root);
        const plans = await listPlanResources(root);
        const unadopted = plans.find((plan) => plan.name === "unadopted");
        strictEqual(unadopted?.planId, "");
        deepStrictEqual(unadopted?.readAvailability, { kind: "pending", message: WORKFLOW_DETAILS_PENDING });
        strictEqual("readAvailability" in (unadopted?.attrs || {}), false);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("pending runtime retains local documents without projecting workflow truth or adopting storage", async () => {
    const root = await fixture.checkout();
    try {
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        await writeFile(
            join(legacy, "name%3Aordinary.json"),
            JSON.stringify({
                version: 1,
                revision: 1,
                planName: "ordinary",
                state: { executionReport: "legacy report" },
            }),
        );
        await writeFile(join(legacy, "name%3Aordinary.json.lock"), "");
        await writeDocument(root, "ordinary", document("ordinary-id", "executionMode: worktree\nworktreeId: stale\n"));
        const before = await snapshot(root);
        const plans = await listPlanResources(root);
        const ordinary = plans.find((plan) => plan.name === "ordinary");
        ok(ordinary);
        strictEqual(ordinary.readAvailability?.kind, "pending");
        strictEqual(ordinary.attrs.worktreeId, undefined);
        strictEqual(ordinary.attrs.executionMode, undefined);
        strictEqual(ordinary.attrs.executionReport, undefined);
        deepStrictEqual((await listPlans(root)).map((plan) => plan.name).sort(), ["epic", "ordinary"]);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("legacy document controller hints stay pending instead of being imported by reads", async () => {
    const root = await fixture.checkout();
    try {
        await enterProjectRuntime(root);
        await writeDocument(root, "ordinary", document("ordinary-id", "executionReport: legacy report\n"));
        const before = await snapshot(root);
        const plan = await loadPlan(root, "ordinary");
        strictEqual(plan?.readAvailability?.kind, "pending");
        strictEqual(plan?.attrs.executionReport, undefined);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("blocked catalog preserves the specific runtime refusal rather than dropping documents", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await writeFile(layout.primary.layoutMarkerPath, JSON.stringify({ version: 999 }));
        await rejects(() => loadPlan(root, "ordinary"), ProjectRuntimeEntryRefusedError);
        await rejects(() => listPlans(root), ProjectRuntimeEntryRefusedError);
        await rejects(() => listPlanResources(root), /newer/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("target snapshot identity and body reads use local Git bytes without filesystem hydration", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["remote", "add", "origin", `${root}-unavailable.git`]);
        const before = await snapshot(root);
        const resource = await findPlanById(root, "child-id");
        const commit = await git(root, ["rev-parse", "target"]);
        strictEqual(resource.path, `${commit}:docs/plans/epic/01-child.md`);
        strictEqual(resource.body.includes("Résumé 世界 🧭"), true);
        const body = await loadPlanBodyById(root, "child-id");
        strictEqual(body.markdown, resource.markdown);
        strictEqual(body.body, resource.body);
        ok(body.bodyHash);
        throws(() => getPlanDocumentRoot(resource.path), /not a writable document/);
        throws(() => getPlanDocumentRoot("HEAD:docs/plans/ordinary.md"), /not a writable document/);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("target snapshots use the same strict full-text parser as local Plans", async () => {
    const root = await fixture.checkout();
    try {
        const markdown = `${document("broken-id")}\n<<<<<<< unresolved\n`;
        await writeDocument(root, "broken", markdown);
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "malformed document"]);
        const commit = await git(root, ["rev-parse", "HEAD"]);
        const parsed = await parsePlanTextStrict(markdown, `${commit}:docs/plans/broken.md`);
        strictEqual(parsed.kind, "malformed");
        const before = await snapshot(root);
        await rejects(() => loadTargetPlan(root, "broken", commit), /unresolved merge conflict markers/);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("durable publication receipts still project completion without remote verification", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["remote", "add", "origin", `${root}-unavailable.git`]);
        await writeControllerState(
            root,
            { planName: "ordinary", planId: "ordinary-id" },
            {
                publicationReceipt: {
                    validatedCommit: "a".repeat(40),
                    publishedCommit: "b".repeat(40),
                    targetBranch: "main",
                },
            },
        );
        const before = await snapshot(root);
        const plan = await loadPlan(root, "ordinary");
        strictEqual(plan?.attrs.status, "verified");
        strictEqual(plan?.readAvailability?.kind, "ready");
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("passive resources keep archive exclusion and reject duplicate identities", async () => {
    const root = await fixture.checkout();
    try {
        await writeDocument(root, "archived/old", document("ordinary-id"));
        strictEqual(
            (await listPlanResources(root)).some((plan) => plan.name === "archived/old"),
            false,
        );
        await writeDocument(root, "duplicate", document("ordinary-id"));
        const before = await snapshot(root);
        await rejects(() => listPlanResources(root), /Duplicate planId/);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("target loading works when temporary filesystem allocation is unavailable", async () => {
    const root = await fixture.checkout();
    try {
        await withProcessGlobalTestLock(async () => {
            const previous = process.env.TMPDIR;
            const before = await snapshot(root);
            try {
                process.env.TMPDIR = join(root, "missing", "temporary");
                const commit = await git(root, ["rev-parse", "target"]);
                const plan = await loadTargetPlan(root, "epic/01-child", commit);
                strictEqual(plan?.attrs.planId, "child-id");
                deepStrictEqual(await snapshot(root), before);
            } finally {
                if (previous === undefined) delete process.env.TMPDIR;
                else process.env.TMPDIR = previous;
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("legacy validated documents need lifecycle reconciliation instead of read-time publication proof", async () => {
    const root = await fixture.checkout();
    try {
        await writeDocument(
            root,
            "ordinary",
            document("ordinary-id", "targetBranch: main\n").replace("status: ready_for_work", "status: validated"),
        );
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "legacy validated document on target"]);
        const before = await snapshot(root);
        const plan = await loadPlan(root, "ordinary");
        strictEqual(plan?.attrs.status, "reviewed");
        strictEqual(plan?.attrs.publicationReceipt, undefined);
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("pending archived catalogs retain local documents with their read availability", async () => {
    const root = await fixture.checkout();
    try {
        await writeDocument(root, "archived/old", document("old-id"));
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        await writeFile(
            join(legacy, "name%3Aold.json"),
            JSON.stringify({ version: 1, revision: 1, planName: "old", state: {} }),
        );
        const before = await snapshot(root);
        const archived = await listArchivedPlans(root);
        strictEqual(archived.length, 1);
        strictEqual(archived[0].readAvailability?.kind, "pending");
        strictEqual((await loadArchivedPlan(root, "old"))?.readAvailability?.kind, "pending");
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("missing local target evidence keeps the Epic visible with pending availability", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["branch", "-D", "target"]);
        const before = await snapshot(root);
        const plans = await listPlanResources(root);
        const epic = plans.find((plan) => plan.name === "epic");
        ok(epic);
        strictEqual(epic.readAvailability?.kind, "pending");
        ok(epic.readAvailability?.message?.includes("Workflow details pending"));
        ok(epic.readAvailability?.message?.includes("target"));
        strictEqual(plans.find((plan) => plan.name === "ordinary")?.readAvailability?.kind, "ready");
        deepStrictEqual(await snapshot(root), before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const conflict of ["live-attempt", "candidate", "target", "delivery-candidate", "delivery-target"]) {
    test(`historical receipt does not complete a Plan with a different ${conflict}`, async () => {
        const root = await fixture.checkout();
        try {
            const { addEntry } = await import("./shared/worktree-registry.js");
            const receipt = { validatedCommit: "a".repeat(40), publishedCommit: "b".repeat(40), targetBranch: "main" };
            const extra =
                conflict === "candidate"
                    ? `validatedCommit: ${"c".repeat(40)}\n`
                    : conflict === "target"
                      ? "targetBranch: release\n"
                      : "";
            await writeDocument(root, "ordinary", document("ordinary-id", extra));
            await writeControllerState(
                root,
                { planName: "ordinary", planId: "ordinary-id" },
                {
                    publicationReceipt: receipt,
                    ...(conflict.startsWith("delivery-")
                        ? {
                              deliveryEvidence: {
                                  version: 1,
                                  mode: "worktree_merge",
                                  executionCommit:
                                      conflict === "delivery-candidate" ? "c".repeat(40) : receipt.validatedCommit,
                                  targetBranch: conflict === "delivery-target" ? "release" : "main",
                                  targetHeadBeforeMerge: "d".repeat(40),
                              },
                          }
                        : {}),
                },
            );
            if (conflict === "live-attempt") {
                const path = join(root, "execution");
                await git(root, ["worktree", "add", "-b", "execution", path]);
                await addEntry(root, {
                    id: "new-attempt",
                    planId: "ordinary-id",
                    planName: "ordinary",
                    path,
                    branch: "execution",
                    baseBranch: "main",
                    baseRef: "main",
                    baseCommit: await git(root, ["rev-parse", "HEAD"]),
                    status: "active",
                    createdAt: "now",
                    updatedAt: "now",
                });
            }
            const before = await snapshot(root);
            const plan = await loadPlan(root, "ordinary");
            strictEqual(plan?.attrs.status, "ready_for_work");
            deepStrictEqual(plan?.attrs.publicationReceipt, receipt, "historical receipt must remain saved");
            deepStrictEqual(await snapshot(root), before);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const invalid of ["directory", "foreign-repository", "symlink", "document-symlink"]) {
    test(`registered ${invalid} cannot supply Plan authority or expose a stale primary document`, async () => {
        const root = await fixture.checkout();
        const foreign = await fixture.checkout();
        try {
            const { addEntry } = await import("./shared/worktree-registry.js");
            const { resolveWorkflowPlanLocation } = await import("./shared/workflow/plan-location.ts");
            const { preparePlanController } = await import("./shared/workflow/plan-preparation.ts");
            const { assertAuthorizedPlanPath } = await import("./ui/workspace/server/project-artifacts.ts");
            const { symlink } = await import("node:fs/promises");
            const { RegisteredPlanDocumentUnavailableError } = await import("./shared/workflow/controller-registry.ts");
            await enterProjectRuntime(root);
            let path = join(root, "unattached");
            if (invalid === "foreign-repository") path = foreign;
            else if (invalid === "symlink") await symlink(foreign, path);
            else if (invalid === "document-symlink") {
                await git(root, ["worktree", "add", "-b", "registered", path]);
                await rm(join(path, "docs/plans/ordinary.md"));
                await symlink(join(foreign, "docs/plans/ordinary.md"), join(path, "docs/plans/ordinary.md"));
            } else await writeDocument(path, "ordinary", document("ordinary-id", "", "# Unauthorized bytes\n"));
            await addEntry(root, {
                id: "invalid",
                planId: "ordinary-id",
                planName: "ordinary",
                path,
                branch: "registered",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
                status: "active",
                createdAt: "now",
                updatedAt: "now",
            });
            strictEqual(
                (await listPlans(root)).some((plan) => plan.name === "ordinary"),
                false,
            );
            ok(
                (await listPlans(root)).some((plan) => plan.name === "epic"),
                "healthy Plans must remain available",
            );
            await rejects(
                () => resolveWorkflowPlanLocation(root, "ordinary", { readOnly: true }),
                RegisteredPlanDocumentUnavailableError,
            );
            await rejects(() => preparePlanController(root, "ordinary"), RegisteredPlanDocumentUnavailableError);
            await rejects(() => assertAuthorizedPlanPath(root, join(path, "docs/plans/ordinary.md"), "ordinary"));
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(foreign, { recursive: true, force: true });
        }
    });
}

test("legacy validated metadata cannot reuse a historical verification timestamp for a different candidate", async () => {
    const root = await fixture.checkout();
    try {
        await writeDocument(
            root,
            "ordinary",
            document("ordinary-id", `validatedCommit: ${"c".repeat(40)}\n`).replace(
                "status: ready_for_work",
                "status: validated",
            ),
        );
        await writeControllerState(
            root,
            { planName: "ordinary", planId: "ordinary-id" },
            {
                verifiedAt: "2026-01-01T00:00:00.000Z",
                publicationReceipt: {
                    validatedCommit: "a".repeat(40),
                    publishedCommit: "b".repeat(40),
                    targetBranch: "main",
                },
            },
        );
        strictEqual((await loadPlan(root, "ordinary"))?.attrs.status, "reviewed");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
