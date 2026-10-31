import { test } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface WorkflowStep {
    name?: string;
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, string | boolean>;
}
interface WorkflowJob {
    if?: string;
    needs?: string | string[];
    steps?: WorkflowStep[];
    outputs?: Record<string, string>;
    "timeout-minutes"?: number;
}
interface WorkflowInput {
    required: boolean;
    type: string;
    default?: boolean;
}
interface ReleaseWorkflow {
    on: { workflow_dispatch: { inputs: Record<string, WorkflowInput> } };
    jobs: Record<string, WorkflowJob>;
}
const workflow = Bun.YAML.parse(await readFile(".github/workflows/release.yml", "utf8")) as ReleaseWorkflow;
const guard = "needs.metadata.outputs.qualification_only != 'true'";

function step(job: string, id: string): WorkflowStep {
    const value = workflow.jobs[job].steps?.find((entry) => entry.id === id || entry.name === id);
    ok(value, `Missing ${job}/${id}`);
    return value;
}

test("qualification dispatch is opt-in and recovery tag is optional only for qualification", async () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    equal(inputs.qualification_only.type, "boolean");
    equal(inputs.qualification_only.default, false);
    equal(inputs.tag.required, false);
    const root = await mkdtemp(join(tmpdir(), "ssh-workflow-"));
    try {
        const script = step("metadata", "metadata").run!;
        // Run the real input validator and metadata command, not a parallel test implementation.
        const invalid = spawnSync("bash", ["-euc", script], {
            env: { ...process.env, DISPATCH: "true", QUALIFICATION_ONLY: "false", RECOVERY_TAG: "" },
            encoding: "utf8",
        });
        equal(invalid.status, 1);
        match(invalid.stderr, /Recovery requires tag/);
        const mixed = spawnSync("bash", ["-euc", script], {
            env: { ...process.env, DISPATCH: "true", QUALIFICATION_ONLY: "true", RECOVERY_TAG: "v1.0.0" },
            encoding: "utf8",
        });
        equal(mixed.status, 1);
        match(mixed.stderr, /does not accept a recovery tag/);
        // Validation script writes metadata.json in cwd, so use the actual release metadata CLI separately.
        const candidate = JSON.parse(
            execFileSync(process.execPath, ["scripts/release.js", "metadata", "--tag", "v0.0.0-rc.1"], {
                encoding: "utf8",
            }),
        );
        equal(candidate.kind, "candidate");
        equal(candidate.buildVersion, "v0.0.0-rc.1");
        match(step("metadata", "metadata").env!.RELEASE_TAG, /inputs.qualification_only && 'v0.0.0-rc.1'/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("qualification selects github.sha without resolving or recovering a release tag", async () => {
    const source = step("metadata", "source").run!;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const root = await mkdtemp(join(tmpdir(), "ssh-source-"));
    try {
        const output = join(root, "output");
        execFileSync("bash", ["-euc", source], {
            env: {
                ...process.env,
                QUALIFICATION_ONLY: "true",
                RECOVERY: "true",
                GITHUB_SHA: sha,
                GITHUB_OUTPUT: output,
                RELEASE_TAG: "this-tag-must-not-be-fetched",
            },
        });
        match(
            await readFile(output, "utf8"),
            new RegExp(`sha=${sha}\\nbun_version=1\\.4\\.3\\nlegacy_containers=false`),
        );
        match(source, /else\s+git fetch --no-recurse-submodules --no-tags origin "refs\/tags\/\$RELEASE_TAG"/);
        equal(step("metadata", "existing").if, "${{ !inputs.qualification_only }}");
        match(workflow.jobs.metadata.outputs!.published, /\|\| 'false'/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("every publication or promotion job explicitly rejects qualification mode", () => {
    const required = new Set([
        "release",
        "homebrew-package",
        "publish-docs",
        "integrate-release-branch",
        "docs-artifact",
    ]);
    for (const [name, job] of Object.entries(workflow.jobs)) {
        const mutation = job.steps?.some((entry) =>
            /action-gh-release|git push|gh workflow run|integrate-release-branch\.sh|reconcile-docs-branch\.sh/.test(
                `${entry.uses || ""}\n${entry.run || ""}`,
            ),
        );
        if (required.has(name) || mutation) {
            ok(job.if?.includes(guard), `${name} could mutate publication state during qualification`);
            required.delete(name);
        }
    }
    equal(required.size, 0, "A required publication barrier disappeared");
});

test("published recovery retains native identity checks without demanding new remote features from old bytes", () => {
    const identity = step("native-package-check", "Validate the actual native release archive");
    equal(identity.if, undefined, "Published recovery must still check native archive identity");
    match(identity.run!, /--remote-preflight/);
    equal(
        step("native-package-check", "Qualify release archive over real loopback SSH").if,
        "runner.os == 'Linux' && needs.metadata.outputs.published != 'true'",
        "Every unpublished Linux release must run the new SSH gate",
    );
    equal(step("metadata", "existing").if, "${{ !inputs.qualification_only }}");
    equal(workflow.jobs.metadata.outputs!.published, "${{ steps.existing.outputs.published || 'false' }}");
});

test("qualification keeps candidate archive and native gates but avoids unrelated full lanes", () => {
    for (const name of [
        "ci-shards",
        "golden-shards",
        "release-check",
        "unix-checks",
        "containers-checks",
        "homebrew-check",
        "ci",
        "golden",
    ]) {
        ok(workflow.jobs[name].if?.includes(guard), `${name} runs unnecessarily during archive qualification`);
    }
    for (const name of ["build", "assets", "native-package-check"]) {
        equal(workflow.jobs[name].if?.includes(guard), false, `${name} must still qualify candidate bytes`);
    }
    const native = workflow.jobs["native-package-check"];
    equal(native["timeout-minutes"], 10);
    const install = step("native-package-check", "Install frozen dependencies for Linux SSH gate");
    const ssh = step("native-package-check", "Qualify release archive over real loopback SSH");
    equal(install.if, "runner.os == 'Linux' && needs.metadata.outputs.published != 'true'");
    equal(ssh.if, "runner.os == 'Linux' && needs.metadata.outputs.published != 'true'");
    equal(install.run, "bun run install:locked");
    match(ssh.run!, /bun scripts\/check-remote-ssh-package.ts release-upload/);
    ok(native.steps!.indexOf(install) < native.steps!.indexOf(ssh));
    const evidence = step("native-package-check", "Retain SSH qualification evidence");
    match(evidence.if!, /always\(\)/);
    equal(evidence.with!.path, "${{ runner.temp }}/wld-remote-ssh-evidence-*/");
    match(workflow.jobs.release.if!, /needs.native-package-check.result == 'success'/);
});
