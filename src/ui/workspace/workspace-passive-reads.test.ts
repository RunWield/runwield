import { test } from "node:test";
import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getRunWieldRuntimeDir } from "../../constants.js";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import {
    enterProjectRuntime,
    resolveProjectRuntimeLayout,
    WORKFLOW_DETAILS_PENDING,
} from "../../shared/project-runtime-layout.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { addEntry } from "../../shared/worktree-registry.js";
import { loadOwnerSidebar } from "./server/owner-dashboard.ts";
import { createOwnerWorkspaceApp } from "./server.js";

function document(id: string, body = "Primary compass", extra = "") {
    return `---\n${id ? `planId: ${id}\n` : ""}classification: FEATURE\nstatus: in_progress\n${extra}---\n# ${body}\n`;
}
async function put(path: string, bytes: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
}
async function tree(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            result[`${entry.name}/`] = "directory";
            for (const [name, bytes] of Object.entries(await tree(path))) result[`${entry.name}/${name}`] = bytes;
        } else if (entry.isSymbolicLink()) result[entry.name] = `symlink:${await readlink(path)}`;
        else result[entry.name] = (await readFile(path)).toString("base64");
    }
    return result;
}
async function snapshot(root: string) {
    return { project: await tree(root), runtime: await tree(getRunWieldRuntimeDir(root)) };
}
const fixture = defineGitFixture(async (root) => {
    await put(join(root, "docs/plans/ordinary.md"), document("ordinary-id"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "raw documents"]);
});

async function workspace(root: string) {
    const dir = await mkdtemp(join(tmpdir(), "workspace-passive-"));
    const store = openOwnerCoordinationStore({ dbPath: join(dir, "owner.sqlite3") });
    const project = store.registerProject({ root, displayName: "Compass Project" });
    const pairing = store.createPairingRequest({ codeFactory: () => "READ12", proofFactory: () => "proof" });
    store.approvePairingRequest(pairing.code);
    const claimed = store.claimPairingRequest(pairing.proof, {
        credentialFactory: () => "reader",
        csrfFactory: () => "csrf",
    });
    const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    return {
        app,
        store,
        project,
        async get(path: string) {
            const response = await app.handler()(
                new Request(`http://127.0.0.1:8787${path}`, {
                    headers: { cookie: `rw_owner_device=${claimed.credential}; rw_owner_csrf=csrf` },
                }),
            );
            strictEqual(response.status, 200, `${path}: ${response.status}`);
            return response;
        },
        async close() {
            await app.close();
            store.close();
            await rm(dir, { recursive: true, force: true });
        },
    };
}

for (const state of ["fresh", "legacy", "interrupted", "adopted", "returning-legacy"]) {
    test(`production Workspace ${state} reads preserve sources after repeated and settled routes`, async () => {
        const root = await fixture.checkout();
        let owner: Awaited<ReturnType<typeof workspace>> | undefined;
        try {
            const legacy = join(getRunWieldRuntimeDir(root), "controller");
            const layout = resolveProjectRuntimeLayout(root);
            if (["adopted", "returning-legacy"].includes(state)) await enterProjectRuntime(root);
            if (["legacy", "returning-legacy"].includes(state)) {
                await put(
                    join(legacy, "plans/name%3Aordinary.json"),
                    JSON.stringify({
                        version: 1,
                        revision: 1,
                        planName: "ordinary",
                        state: { executionReport: "Legacy evidence" },
                    }),
                );
            }
            if (state === "interrupted") {
                await put(
                    join(layout.primary.internalRoot, "controller/plans/name%3Aordinary.json"),
                    JSON.stringify({ version: 1, revision: 1, planName: "ordinary", state: {} }),
                );
                await put(
                    layout.primary.layoutMigrationJournalPath,
                    JSON.stringify({
                        version: 1,
                        primaryCheckoutRoot: root,
                        selectedCheckoutRoots: [root],
                        operations: [
                            {
                                action: "rename",
                                source: legacy,
                                destination: join(layout.primary.internalRoot, "controller"),
                                kind: "directory",
                                completed: false,
                            },
                        ],
                        updatedAt: "2026-01-01T00:00:00.000Z",
                    }),
                );
            }
            await put(join(root, "docs/plans/no-id.md"), document("", "Unadopted compass"));
            const pending = ["legacy", "interrupted"].includes(state);
            const before = await snapshot(root);
            owner = await workspace(root);
            const base = `/api/owner/projects/${owner.project.projectId}/plans`;
            for (let repeat = 0; repeat < 2; repeat++) {
                const board = await (await owner.get(base)).json();
                ok(JSON.stringify(board).includes("ordinary-id"));
                ok(JSON.stringify(board).includes(WORKFLOW_DETAILS_PENDING)); // ID-less document remains visible.
                const detail = await (await owner.get(`${base}/ordinary-id`)).json();
                ok(JSON.stringify(detail).includes("Primary compass"));
                strictEqual(detail.plan.readAvailability.kind, pending ? "pending" : "ready");
                strictEqual("readAvailability" in detail.plan.attrs, false);
                const progress = await (await owner.get(`${base}/ordinary-id/progress`)).json();
                strictEqual(progress.degraded?.code || null, pending ? "workflow_details_pending" : null);
                const dashboard = await (await owner.get("/api/owner/dashboard")).json();
                const sidebar = await (await owner.get("/api/owner/sidebar")).json();
                strictEqual(JSON.stringify(dashboard).includes(WORKFLOW_DETAILS_PENDING), true);
                strictEqual(JSON.stringify(sidebar).includes(WORKFLOW_DETAILS_PENDING), true);
                await owner.app.workspaceSearch.refresh();
                const search = await (await owner.get("/api/owner/search?q=compass")).json();
                strictEqual(
                    search.results.some((row: { sourceId: string }) => row.sourceId === "ordinary-id"),
                    !pending,
                );
                const html = await (await owner.get(`/projects/${owner.project.projectId}/plans`)).text();
                ok(html.includes("name=no-id"));
                ok(html.includes(WORKFLOW_DETAILS_PENDING));
                const documentHtml = await (
                    await owner.get(`/projects/${owner.project.projectId}/plans/document?name=no-id`)
                ).text();
                ok(documentHtml.includes("Unadopted compass"));
                ok(documentHtml.includes(WORKFLOW_DETAILS_PENDING));
                const detailHtml = await (
                    await owner.get(`/projects/${owner.project.projectId}/plans/ordinary-id`)
                ).text();
                if (pending) ok(detailHtml.includes(WORKFLOW_DETAILS_PENDING));
                deepStrictEqual(await snapshot(root), before);
            }
            await owner.app.workspaceSearch.close();
            await new Promise((resolve) => setTimeout(resolve, 40));
            deepStrictEqual(await snapshot(root), before);
        } finally {
            await owner?.close();
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("production Workspace uses current registered Plan and controller fields across requests", async () => {
    const root = await fixture.checkout();
    let owner: Awaited<ReturnType<typeof workspace>> | undefined;
    try {
        await enterProjectRuntime(root);
        const worktree = join(root, "execution");
        await git(root, ["worktree", "add", "-b", "execution", worktree]);
        const path = join(worktree, "docs/plans/ordinary.md");
        await put(
            path,
            document("ordinary-id", "Registered compass").replace("status: in_progress", "status: implemented"),
        );
        await writeControllerState(
            worktree,
            { planName: "ordinary", planId: "ordinary-id" },
            { executionReport: "Current controller" },
        );
        await addEntry(root, {
            id: "attempt",
            planId: "ordinary-id",
            planName: "ordinary",
            path: worktree,
            branch: "execution",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: "a".repeat(40),
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        owner = await workspace(root);
        const base = `/api/owner/projects/${owner.project.projectId}/plans`;
        for (const title of ["Registered compass", "Updated compass"]) {
            if (title.startsWith("Updated"))
                await put(path, document("ordinary-id", title).replace("status: in_progress", "status: implemented"));
            const before = await snapshot(root);
            const detail = await (await owner.get(`${base}/ordinary-id`)).json();
            strictEqual(detail.plan.status, "implemented");
            strictEqual(detail.plan.attrs.worktreeBaseCommit, "a".repeat(40));
            strictEqual(detail.plan.attrs.executionReport, "Current controller");
            ok(detail.plan.markdown.includes(title));
            const board = await (await owner.get(base)).json();
            ok(JSON.stringify(board).includes("Current controller"));
            await owner.get("/api/owner/dashboard");
            await owner.get("/api/owner/sidebar");
            await owner.app.workspaceSearch.refresh();
            const found = await (await owner.get("/api/owner/search?q=compass")).json();
            strictEqual(found.results[0].title, title);
            const progress = await (await owner.get(`${base}/ordinary-id/progress`)).json();
            strictEqual(progress.plan.status, "implemented");
            deepStrictEqual(await snapshot(root), before);
        }
    } finally {
        await owner?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("pending search withholds indexed primary copies during current hydration and keeps healthy Projects", async () => {
    const root = await fixture.checkout();
    const healthy = await fixture.checkout();
    let owner: Awaited<ReturnType<typeof workspace>> | undefined;
    try {
        owner = await workspace(root);
        const other = owner.store.registerProject({ root: healthy, displayName: "Healthy" });
        await owner.app.workspaceSearch.refresh();
        strictEqual((await (await owner.get("/api/owner/search?q=compass")).json()).results.length, 2);
        await put(
            join(getRunWieldRuntimeDir(root), "controller/plans/name%3Aordinary.json"),
            JSON.stringify({ version: 1, revision: 1, planName: "ordinary", state: {} }),
        );
        const before = await snapshot(root);
        for (const refresh of [false, true]) {
            if (refresh) await owner.app.workspaceSearch.refresh();
            const found = await (await owner.get("/api/owner/search?q=compass")).json();
            deepStrictEqual(
                found.results.map((row: { projectId: string }) => row.projectId),
                [other.projectId],
            );
            ok(JSON.stringify(found.states).includes(WORKFLOW_DETAILS_PENDING));
            deepStrictEqual(await snapshot(root), before);
        }
    } finally {
        await owner?.close();
        await rm(root, { recursive: true, force: true });
        await rm(healthy, { recursive: true, force: true });
    }
});

for (const failure of ["newer-marker", "linked-document-directory"]) {
    test(`query-time Plan authority failure reports a safe reader state and keeps healthy Projects (${failure})`, async () => {
        const root = await fixture.checkout();
        const healthy = await fixture.checkout();
        const outside = `${root}-outside-plans`;
        let owner: Awaited<ReturnType<typeof workspace>> | undefined;
        try {
            await enterProjectRuntime(root);
            owner = await workspace(root);
            const other = owner.store.registerProject({ root: healthy, displayName: "Healthy" });
            await owner.app.workspaceSearch.refresh();
            const indexed = await (await owner.get("/api/owner/search?q=compass")).json();
            strictEqual(indexed.results.length, 2);
            strictEqual(
                indexed.states.find((state: { projectId: string }) => state.projectId === owner?.project.projectId)
                    .state,
                "ready",
            );
            if (failure === "newer-marker") {
                await writeFile(
                    resolveProjectRuntimeLayout(root).primary.layoutMarkerPath,
                    JSON.stringify({ version: 999 }),
                );
            } else {
                await rename(join(root, "docs/plans"), outside);
                await symlink(outside, join(root, "docs/plans"));
            }
            const before = {
                failed: await snapshot(root),
                healthy: await snapshot(healthy),
                outside: await tree(outside),
            };
            // Do not refresh: query hydration must detect changes made after the index became ready.
            for (let repeat = 0; repeat < 2; repeat++) {
                const found = await (await owner.get("/api/owner/search?q=compass")).json();
                deepStrictEqual(
                    found.results.map((row: { projectId: string }) => row.projectId),
                    [other.projectId],
                );
                deepStrictEqual(
                    found.states.find((state: { projectId: string }) => state.projectId === owner?.project.projectId),
                    {
                        projectId: owner.project.projectId,
                        state: "failed",
                        reader: "Plan reader",
                        message: "Plan reader indexing failed.",
                    },
                );
                strictEqual(JSON.stringify(found).includes(root), false);
                strictEqual(JSON.stringify(found).includes(outside), false);
                deepStrictEqual(
                    { failed: await snapshot(root), healthy: await snapshot(healthy), outside: await tree(outside) },
                    before,
                );
            }
        } finally {
            await owner?.close();
            await rm(root, { recursive: true, force: true });
            await rm(healthy, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
}

test("production Workspace reads target-only Plans from local Git objects without filesystem hydration", async () => {
    const root = await fixture.checkout();
    let owner: Awaited<ReturnType<typeof workspace>> | undefined;
    try {
        await git(root, ["switch", "-c", "target"]);
        await put(
            join(root, "docs/plans/epic/01-child.md"),
            document("target-id", "Target compass", "parentPlan: epic\norder: 1\n"),
        );
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "target child"]);
        await git(root, ["switch", "main"]);
        await put(
            join(root, "docs/plans/epic.md"),
            "---\nplanId: epic-id\nclassification: PROJECT\ntargetBranch: target\n---\n# Epic\n",
        );
        await git(root, ["remote", "add", "origin", `${root}-unavailable.git`]);
        const before = await snapshot(root);
        owner = await workspace(root);
        const { findPlanById } = await import("../../plan-store.js");
        const { assertAuthorizedPlanPath, assertReadablePlanResource } = await import("./server/project-artifacts.ts");
        const { loadWorkspaceDetail } = await import("./server/plan-adapter.js");
        const resource = await findPlanById(root, "target-id");
        await assertReadablePlanResource(root, resource);
        await rejects(() => assertAuthorizedPlanPath(root, resource.path, resource.planName));
        strictEqual((await loadWorkspaceDetail(root, "target-id")).capabilities.bodyEditing, false);
        for (let repeat = 0; repeat < 2; repeat++) {
            const detail = await (
                await owner.get(`/api/owner/projects/${owner.project.projectId}/plans/target-id`)
            ).json();
            ok(detail.plan.body.includes("Target compass"));
            await owner.app.workspaceSearch.refresh();
            const found = await (await owner.get("/api/owner/search?q=compass")).json();
            ok(found.results.some((row: { sourceId: string }) => row.sourceId === "target-id"));
            deepStrictEqual(await snapshot(root), before);
        }
    } finally {
        await owner?.close();
        await rm(root, { recursive: true, force: true });
    }
});

for (const pending of [false, true]) {
    test(`owner sidebar and Board retain named parse warnings with ${pending ? "pending" : "ready"} healthy Plans`, async () => {
        const root = await fixture.checkout();
        let owner: Awaited<ReturnType<typeof workspace>> | undefined;
        try {
            if (!pending) await enterProjectRuntime(root);
            if (pending) {
                await put(
                    join(getRunWieldRuntimeDir(root), "controller/plans/name%3Aordinary.json"),
                    JSON.stringify({ version: 1, revision: 1, planName: "ordinary", state: {} }),
                );
            }
            const broken = join(root, "docs/plans/broken.md");
            await put(broken, "---\naffectedPaths: - src/a.ts\n  status: draft\n---\n# Broken\n");
            await put(
                join(root, "docs/plans/other-broken.md"),
                `---\nsummary: [<img src=x onerror=alert(1)>, ${root}\n---\n# Broken\n`,
            );
            owner = await workspace(root);
            const before = await snapshot(root);
            const base = `/api/owner/projects/${owner.project.projectId}/plans`;
            for (let repeat = 0; repeat < 2; repeat++) {
                const sidebar = await (await owner.get("/api/owner/sidebar")).json();
                const project = sidebar.projects[0];
                const withSessions = await loadOwnerSidebar(owner.store, {
                    async listSessions() {
                        return {
                            sessions: [
                                {
                                    runwieldSessionId: "warning-session",
                                    displayName: "Preserved Session",
                                    state: "idle",
                                },
                            ],
                        };
                    },
                });
                strictEqual(withSessions[0].sessions[0]?.runwieldSessionId, "warning-session");
                deepStrictEqual(withSessions[0].planDiagnostics, project.planDiagnostics);
                strictEqual(project.plans.length, pending ? 0 : 1);
                strictEqual(project.planDiagnostics.length, 2);
                deepStrictEqual(project.planDiagnostics.map((issue: { name: string }) => issue.name).sort(), [
                    "broken",
                    "other-broken",
                ]);
                ok(project.planDiagnostics.some((issue: { message: string }) => issue.message.includes("(1:16)")));
                strictEqual(
                    project.diagnostics.some((issue: { message: string }) => issue.message.includes("indentation")),
                    false,
                );
                strictEqual(JSON.stringify(project.planDiagnostics).includes(root), false);
                strictEqual(JSON.stringify(project.planDiagnostics).includes('"path"'), false);
                const board = await (await owner.get(base)).json();
                ok(JSON.stringify(board.board).includes("ordinary-id"));
                deepStrictEqual(board.diagnostics, project.planDiagnostics);
                deepStrictEqual(await snapshot(root), before);
            }
            await put(join(root, "docs/plans/ordinary.md"), "---\naffectedPaths: - src/a.ts\n---\n# Broken\n");
            const allMalformed = await (await owner.get("/api/owner/sidebar")).json();
            strictEqual(allMalformed.projects[0].plans.length, 0);
            strictEqual(allMalformed.projects[0].planDiagnostics.length, 3);
            await put(join(root, "docs/plans/ordinary.md"), document("ordinary-id"));
            await put(broken, document("fixed-id", "Fixed Plan"));
            let sidebar = await (await owner.get("/api/owner/sidebar")).json();
            deepStrictEqual(
                sidebar.projects[0].planDiagnostics.map((issue: { name: string }) => issue.name),
                ["other-broken"],
            );
            await rm(join(root, "docs/plans/other-broken.md"));
            sidebar = await (await owner.get("/api/owner/sidebar")).json();
            deepStrictEqual(sidebar.projects[0].planDiagnostics, []);
        } finally {
            await owner?.close();
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const source of ["target", "registered"]) {
    test(`owner sidebar and Board isolate a malformed ${source} authority without stale primary content`, async () => {
        const root = await fixture.checkout();
        const worktree = `${root}-warning-authority`;
        let owner: Awaited<ReturnType<typeof workspace>> | undefined;
        try {
            await enterProjectRuntime(root);
            const broken = "---\naffectedPaths: - src/a.ts\n  status: draft\n---\n# Broken\n";
            if (source === "target") {
                await git(root, ["switch", "-c", "target"]);
                await put(join(root, "docs/plans/broken-target.md"), broken);
                await put(
                    join(root, "docs/plans/healthy-child.md"),
                    document("child-id", "Healthy child", "parentPlan: epic\n"),
                );
                await git(root, ["add", "."]);
                await git(root, ["commit", "-m", "target warning"]);
                await git(root, ["update-ref", "refs/remotes/origin/target", "HEAD"]);
                await git(root, ["switch", "main"]);
                await put(
                    join(root, "docs/plans/epic.md"),
                    "---\nplanId: epic-id\nclassification: PROJECT\ntargetBranch: target\n---\n# Epic\n",
                );
            } else {
                await git(root, ["worktree", "add", "-b", "warning-authority", worktree]);
                await put(join(worktree, "docs/plans/ordinary.md"), broken);
                await addEntry(root, {
                    id: "warning-attempt",
                    planId: "ordinary-id",
                    planName: "ordinary",
                    path: worktree,
                    branch: "warning-authority",
                    baseBranch: "main",
                    baseRef: "main",
                    baseCommit: "a".repeat(40),
                    status: "active",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                });
                await put(join(root, "docs/plans/healthy.md"), document("healthy-id", "Healthy neighbor"));
            }
            owner = await workspace(root);
            const before = await snapshot(root);
            const sidebar = await (await owner.get("/api/owner/sidebar")).json();
            const project = sidebar.projects[0];
            strictEqual(project.planDiagnostics.length, 1);
            strictEqual(project.planDiagnostics[0].name, source === "target" ? "broken-target" : "ordinary");
            if (source === "registered") {
                strictEqual(project.planDiagnostics[0].planId, "ordinary-id");
                strictEqual(
                    project.plans.some((plan: { planId: string }) => plan.planId === "ordinary-id"),
                    false,
                );
            }
            ok(
                project.plans.some(
                    (plan: { planId: string }) => plan.planId === (source === "target" ? "child-id" : "healthy-id"),
                ),
            );
            const board = await (await owner.get(`/api/owner/projects/${owner.project.projectId}/plans`)).json();
            deepStrictEqual(board.diagnostics, project.planDiagnostics);
            strictEqual(JSON.stringify(board.diagnostics).includes(root), false);
            deepStrictEqual(await snapshot(root), before);
        } finally {
            await owner?.close();
            await rm(worktree, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
}
