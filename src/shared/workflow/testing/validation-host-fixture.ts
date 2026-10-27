import { runtimeSourceArgs } from "../../../testing/runtime-source-args.ts";
import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    writeFile as fsWriteFile,
    realpath as fsRealpath,
    mkdir as fsMkdir,
    chmod as fsChmod,
    stat as fsStat,
    readFile as fsReadFile,
    rm as fsRm,
} from "node:fs/promises";
import { join } from "node:path";
import { getCwd } from "../../../constants.js";
import { captureForegroundProcess } from "../../captured-process.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists } from "../../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { defineGitFixture, git } from "../../git-test-fixture.ts";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../../plan-store.js";
import { controllerRecordPath } from "../controller-registry.ts";
import { addEntry } from "../../worktree-registry.js";
import { setCustomSetting, setExactProjectCustomSetting } from "../../settings.js";
import { parseDiffFiles } from "../review-diff.ts";
import {
    type HostTurnValidationResult,
    type ValidationHostRequest,
    type ValidationHostResume,
} from "../validation-host-contract.ts";
import { continueHostTurnValidation } from "../validation-host-turn.ts";
import { readDeliveryEvidence } from "../delivery-evidence.ts";
import { getWorkflowMetricsFilePath } from "../metrics.js";
import { makeValidationProjectRoot } from "../validation-test-helpers.js";

import process from "node:process";

const base = defineGitFixture(async (root) => {
    await fsWriteFile(join(root, ".gitignore"), "marker\nci-count\n");
    await fsWriteFile(join(root, "implementation.ts"), "export const value = 0;\n");
    await fsWriteFile(join(root, "verify.sh"), "#!/bin/sh\nprintf ci\\n >> ci-count\ntest -f marker\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
});
export type HostFixtureOptions = {
    nonGit?: boolean;
    command?: string | null;
    attrs?: Partial<import("../../../plan-store.js").PlanFrontMatter>;
    planOnly?: boolean;
};
export async function hostFixture(options: HostFixtureOptions = {}) {
    const attrs = {
        planId: "plan-host",
        createdAt: "2026-01-01T00:00:00.000Z",
        classification: "PLANNED_CHANGE" as const,
        workKind: "REFACTOR" as const,
        executionAgent: "engineer" as const,
        collaborationRecommendation: "autonomous" as const,
        status: "implemented" as const,
        humanReviewMode: "always" as const,
        targetBranch: "main",
        ...options.attrs,
    };
    const root = await fsRealpath(
        options.nonGit
            ? await makeValidationProjectRoot("p", { ...attrs, executionMode: "non_git_in_place" })
            : await base.checkout(),
    );
    const parent = await fsRealpath(await fsMkdtemp(join(tmpdir(), "host-validation-worktree-")));
    let cwd = root;
    const id = options.nonGit ? "in-place" : "wt-host";
    if (!options.nonGit) {
        if (attrs.parentPlan) {
            await savePlan(
                root,
                attrs.parentPlan,
                "# Epic\n\n## Objective\n\nIntegrate the value.\n\n## Verification Plan\n\nCheck children.\n",
                {
                    planId: "plan-epic",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    classification: "PROJECT",
                    status: "in_progress",
                    targetBranch: "main",
                },
            );
        }
        if (options.command !== null) {
            setExactProjectCustomSetting("verification_command", options.command || "sh verify.sh", root);
        }
        await setCustomSetting("workflowMetrics", true, "project", root);
        await savePlan(root, "p", "# Approved Plan\n\nImplement the value.\n", attrs);
        await git(root, ["add", "docs/plans", ".wld/settings.json"]);
        await git(root, ["commit", "-m", "approved plan"]);
        const baseCommit = await git(root, ["rev-parse", "HEAD"]);
        const baseTree = await git(root, ["rev-parse", "HEAD^{tree}"]);
        cwd = join(parent, "execution");
        const branch = "runwield/worktree/p-wt-host";
        await git(root, ["worktree", "add", "-b", branch, cwd, "HEAD"]);
        await addEntry(root, {
            id,
            planName: "p",
            planId: attrs.planId,
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit,
            baseTree,
            executionBaselineTree: baseTree,
            branch,
            path: cwd,
            status: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        const plan = await loadPlan(cwd, "p");
        assertExists(plan);
        await updatePlanFrontMatter(
            cwd,
            "p",
            {
                ...attrs,
                executionMode: "worktree",
                executionBaselineTree: baseTree,
                worktreeId: id,
                worktreePath: cwd,
                worktreeBranch: branch,
                worktreeBaseBranch: "main",
                worktreeStatus: "completed",
            },
            plan.attrs,
            { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
        );
        if (options.planOnly) {
            await fsWriteFile(
                join(cwd, "docs/plans/p.md"),
                (await fsReadFile(join(cwd, "docs/plans/p.md"), "utf8")) + "\nPlan change.\n",
            );
        } else await fsWriteFile(join(cwd, "implementation.ts"), "export const value = 1; // implemented\n");
    }
    if (options.nonGit) {
        await fsWriteFile(join(cwd, "verify.sh"), "#!/bin/sh\nprintf ci\\n >> ci-count\ntest -f marker\n");
    }
    if (options.command !== null) {
        setExactProjectCustomSetting("verification_command", options.command || "sh verify.sh", cwd);
    }
    await setCustomSetting("workflowMetrics", true, "project", root);
    const bin = join(parent, "bin");
    await fsMkdir(bin);
    const modelMarker = join(bin, "model-started");
    for (const model of ["claude", "pi"]) {
        await fsWriteFile(join(bin, model), `#!/bin/sh\nprintf model > '${modelMarker}'\nexit 99\n`);
        await fsChmod(join(bin, model), 0o755);
    }
    return {
        root,
        cwd,
        id,
        parent,
        bin,
        modelMarker,
        async turn(resume?: ValidationHostResume) {
            return await continueHostTurnValidation({ projectRoot: root, planName: "p", resume });
        },
        async processTurn(resume?: ValidationHostResume): Promise<HostTurnValidationResult> {
            const output = await captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "run",
                    "-A",
                    "--no-check",
                    "--config",
                    fromFileUrl(new URL("../../../../deno.json", import.meta.url)),
                    fromFileUrl(new URL("./validation-host-process.ts", import.meta.url)),
                    JSON.stringify({ projectRoot: root, planName: "p", resume }),
                ]),
                env: { PATH: `${bin}:${process.env["PATH"] || ""}` },
                cwd: getCwd(),
            });
            assert(output.success, new TextDecoder().decode(output.stderr));
            assertEquals(
                await fsStat(modelMarker).then(
                    () => true,
                    () => false,
                ),
                false,
            );
            const text = new TextDecoder().decode(output.stdout);
            const result: HostTurnValidationResult = JSON.parse(text.slice(text.lastIndexOf("HOST_RESULT=") + 12));
            return result;
        },
        async plan() {
            const plan = await loadPlan(cwd, "p");
            assertExists(plan);
            return plan;
        },
        async checkpointBytes() {
            const plan = await loadPlan(cwd, "p");
            assertExists(plan);
            return await fsReadFile(controllerRecordPath(cwd, { planName: "p", planId: plan.attrs.planId }), "utf8");
        },
        async evidence() {
            return (await readDeliveryEvidence(root, "p", id)).entries;
        },
        async ciCount() {
            return (await fsReadFile(join(cwd, "ci-count"), "utf8").catch(() => "")).match(/ci/g)?.length || 0;
        },
        async metrics() {
            return await fsReadFile(getWorkflowMetricsFilePath(root), "utf8").catch(() => "");
        },
        async lifecycle() {
            const text = await fsReadFile(getWorkflowMetricsFilePath(root), "utf8").catch(() => "");
            return text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const metric: { event: string; details?: { operation?: string } } = JSON.parse(line);
                    return metric;
                })
                .filter(
                    (metric) =>
                        metric.event === "plan_transition_committed" ||
                        metric.event === "semantic_transition_committed",
                )
                .map((metric) => metric.details?.operation || "")
                .filter((operation) => operation.startsWith("plan_event:"));
        },
        async close() {
            if (!options.nonGit) await git(root, ["worktree", "remove", "--force", cwd]).catch(() => {});
            await fsRm(parent, { recursive: true });
            await fsRm(root, { recursive: true });
        },
    };
}
export type HostFixture = Awaited<ReturnType<typeof hostFixture>>;
export function hostRequest<K extends ValidationHostRequest["kind"]>(
    result: HostTurnValidationResult,
    kind: K,
): Extract<ValidationHostRequest, { kind: K }> {
    assert(result.kind === "host_request", JSON.stringify(result));
    assertEquals(result.request.kind, kind);
    return result.request as Extract<ValidationHostRequest, { kind: K }>;
}
export function coverage(request: Extract<ValidationHostRequest, { kind: "reviewer" }>) {
    return parseDiffFiles(request.requiredScope === "full" ? request.fullDiff : request.repairDiff).map((file) => ({
        scope: request.requiredScope,
        path: file.path,
        start: 0,
        end: file.byteLength,
    }));
}
export function complete(request: Extract<ValidationHostRequest, { kind: "repair" }>): ValidationHostResume {
    return { kind: "task_completed", identity: request.identity, report: "Fixed the finding." };
}
