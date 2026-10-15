import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { loadPlan, savePlan } from "../../plan-store.js";
import { listEntries } from "../worktree-registry.js";
import { removeWorktreeGitArtifacts } from "../worktree.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { buildEffectProver } from "./transition-recovery.ts";
import { readExecutionSetup } from "./execution-setup.ts";

const repo = defineCommittedGitFixture();
const planName = "dependency-hook";

async function fixture(
    options: {
        failure?: boolean;
        mutation?: boolean;
        configured?: boolean;
        hookFailure?: boolean;
        hookMutation?: boolean;
        hookFormat?: boolean;
    } = {},
) {
    const root = await repo.checkout({ prefix: "execution-setup-" });
    await mkdir(join(root, ".hooks"));
    await mkdir(join(root, ".wld"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await writeFile(
        join(root, ".wld/settings.json"),
        JSON.stringify(
            options.configured === false
                ? {}
                : {
                      worktree_setup_command: "bun setup.cjs",
                  },
        ),
    );
    await writeFile(
        join(root, "setup.cjs"),
        `const fs = require('node:fs');
fs.mkdirSync('node_modules', {recursive: true});
fs.appendFileSync('node_modules/runs', 'run\\n');
${options.failure ? "if (!fs.existsSync('node_modules/allow')) { console.error('bootstrap fixture failed'); process.exit(12); }" : ""}
${options.mutation ? "fs.writeFileSync('unrelated.txt', 'keep this output');" : ""}
fs.writeFileSync('node_modules/hook.cjs', "require('node:fs').appendFileSync('node_modules/hook-runs', 'hook\\\\n')");
`,
    );
    await writeFile(
        join(root, ".hooks/pre-commit"),
        `#!/bin/sh
${
    options.hookFailure
        ? `if [ ! -f node_modules/allow-hook ]; then
${options.hookMutation ? "printf 'unrelated hook output\\n' > docs/plans/hook-output.md" : ""}
echo hook-fixture-failed >&2
exit 7
fi`
        : ""
}
${options.hookFormat ? "printf '\\n' >> docs/plans/dependency-hook.md\ngit add docs/plans/dependency-hook.md" : ""}
exec bun node_modules/hook.cjs
`,
    );
    await chmod(join(root, ".hooks/pre-commit"), 0o755);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture setup contract"]);
    await git(root, ["config", "core.hooksPath", ".hooks"]);
    await savePlan(root, planName, "# Dependency hook", {
        classification: "PLANNED_CHANGE",
        status: "ready_for_work",
        planId: "setup-plan",
        summary: "Dependency hook",
    });
    const session = new HostedSession({ id: "execution-setup-test", cwd: root });
    session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: "bun setup.cjs" }) });
    const start = async () => {
        await startActiveExecutionWorkflow({
            planName,
            triageMeta: { classification: "PLANNED_CHANGE", planId: "setup-plan" },
            currentStatus: "ready_for_work",
            hostedSession: session,
            ports: createExecutionStartPorts(),
        });
        const workflow = session.getActiveExecutionWorkflow();
        assert(workflow);
        return workflow;
    };
    const cleanup = async () => {
        session.dispose();
        for (const entry of await listEntries(root)) {
            await removeWorktreeGitArtifacts({ projectRoot: root, path: entry.path, force: true });
        }
        await rm(root, { recursive: true, force: true });
    };
    return { root, session, start, cleanup };
}

test("fresh execution bootstraps dependencies before hooks and never repeats preparation on resume", async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.root, "user-staged.txt"), "keep staged");
        await git(f.root, ["add", "user-staged.txt"]);
        const originalIndex = await git(f.root, ["diff", "--cached"]);
        const workflow = await f.start();
        const cwd = workflow.executionCwd!;
        assert.equal(await readFile(join(cwd, "node_modules/runs"), "utf8"), "run\n");
        assert.equal(await readFile(join(cwd, "node_modules/hook-runs"), "utf8"), "hook\n");
        assert.equal((await loadPlan(cwd, planName))?.attrs.status, "in_progress");
        assert.equal((await readExecutionSetup(cwd))?.state, "prepared");
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        assert.equal(await git(cwd, ["rev-list", "--count", `${workflow.worktreeBaseCommit}..HEAD`]), "1");
        await f.start();
        assert.equal(await git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(await readFile(join(cwd, "node_modules/runs"), "utf8"), "run\n");
        assert.equal(await git(f.root, ["diff", "--cached"]), originalIndex);
    } finally {
        await f.cleanup();
    }
});

test("failed bootstrap preserves its worktree and retries before execution or a preparation commit", async () => {
    const f = await fixture({ failure: true });
    try {
        await assert.rejects(f.start, /bootstrap fixture failed/);
        assert.equal(f.session.getActiveExecutionWorkflow(), null);
        const [attempt] = await listEntries(f.root);
        assert(attempt);
        assert.equal(attempt.status, "execution_failed");
        assert.equal(await git(attempt.path, ["rev-parse", "HEAD"]), attempt.baseCommit);
        assert.equal((await loadPlan(f.root, planName))?.attrs.status, "ready_for_work");
        assert.equal((await readExecutionSetup(attempt.path))?.state, "pending");
        await writeFile(join(attempt.path, "node_modules/allow"), "retry");
        const workflow = await f.start();
        assert.equal(workflow.executionCwd, attempt.path);
        assert.equal(await readFile(join(attempt.path, "node_modules/runs"), "utf8"), "run\nrun\n");
        assert.equal(await git(attempt.path, ["rev-list", "--count", `${attempt.baseCommit}..HEAD`]), "1");
    } finally {
        await f.cleanup();
    }
});

test("setup output outside ignored dependencies is preserved and cannot be absorbed on retry", async () => {
    const f = await fixture({ mutation: true });
    try {
        await assert.rejects(f.start, /will not be committed as preparation/);
        const [attempt] = await listEntries(f.root);
        assert.equal(await readFile(join(attempt.path, "unrelated.txt"), "utf8"), "keep this output");
        await assert.rejects(f.start, /will not be committed as preparation/);
        assert.equal(await git(attempt.path, ["rev-parse", "HEAD"]), attempt.baseCommit);
        assert.equal(f.session.getActiveExecutionWorkflow(), null);
    } finally {
        await f.cleanup();
    }
});

test("unconfigured hooks require a setup answer and cancellation cannot start execution", async () => {
    const f = await fixture({ configured: false });
    try {
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "canceled" }) });
        await assert.rejects(f.start, /setup was not confirmed/);
        assert.equal((await listEntries(f.root)).length, 0);
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: "bun setup.cjs" }) });
        const workflow = await f.start();
        assert.equal((await readExecutionSetup(workflow.executionCwd!))?.state, "prepared");
    } finally {
        await f.cleanup();
    }
});

test("a failed command can be corrected on retry without editing or committing project files", async () => {
    const f = await fixture({ configured: false });
    try {
        f.session.setInteractionAdapter({
            requestInteraction: () => ({ outcome: "text", value: "bun missing-setup.cjs" }),
        });
        await assert.rejects(f.start, /Worktree setup failed/);
        const [attempt] = await listEntries(f.root);
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: "bun setup.cjs" }) });
        const workflow = await f.start();
        assert.equal(workflow.executionCwd, attempt.path);
        assert.equal(await git(attempt.path, ["rev-list", "--count", `${attempt.baseCommit}..HEAD`]), "1");
        assert.equal((await readExecutionSetup(attempt.path))?.command, "bun setup.cjs");
    } finally {
        await f.cleanup();
    }
});

test("a failed hook retries without duplicate commits after successful setup", async () => {
    const f = await fixture({ hookFailure: true });
    try {
        await assert.rejects(f.start, /hook-fixture-failed/);
        const [attempt] = await listEntries(f.root);
        assert.equal((await readExecutionSetup(attempt.path))?.state, "ready");
        await writeFile(join(attempt.path, "node_modules/allow-hook"), "retry");
        await f.start();
        assert.equal(await git(attempt.path, ["rev-list", "--count", `${attempt.baseCommit}..HEAD`]), "1");
    } finally {
        await f.cleanup();
    }
});

test("a failing hook cannot have unrelated Plan output absorbed into retry preparation", async () => {
    const f = await fixture({ hookFailure: true, hookMutation: true });
    try {
        await assert.rejects(f.start, /hook-fixture-failed/);
        const [attempt] = await listEntries(f.root);
        await writeFile(join(attempt.path, "node_modules/allow-hook"), "retry");
        await assert.rejects(f.start, /will not be committed as preparation/);
        assert.equal(await git(attempt.path, ["rev-parse", "HEAD"]), attempt.baseCommit);
        assert.equal(
            await readFile(join(attempt.path, "docs/plans/hook-output.md"), "utf8"),
            "unrelated hook output\n",
        );
    } finally {
        await f.cleanup();
    }
});

test("an interrupted receipt after a formatting hook commit recovers without rerunning setup", async () => {
    const f = await fixture({ hookFormat: true });
    try {
        const workflow = await f.start();
        const cwd = workflow.executionCwd!;
        const receipt = await readExecutionSetup(cwd);
        assert(receipt);
        await writeFile(
            join(resolveProjectRuntimeLayout(cwd).selected.internalRoot, "execution-setup.json"),
            JSON.stringify({ ...receipt, state: "ready" }),
        );
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        await f.start();
        assert.equal((await readExecutionSetup(cwd))?.state, "prepared");
        assert.equal(await git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(await readFile(join(cwd, "node_modules/runs"), "utf8"), "run\n");
    } finally {
        await f.cleanup();
    }
});

test("an interrupted lifecycle write is recognized without accepting unrelated Plan edits", async () => {
    const f = await fixture({ hookFailure: true });
    try {
        await assert.rejects(f.start, /hook-fixture-failed/);
        const [attempt] = await listEntries(f.root);
        const receipt = await readExecutionSetup(attempt.path);
        assert(receipt);
        delete receipt.checkpointTree;
        await writeFile(
            join(resolveProjectRuntimeLayout(attempt.path).selected.internalRoot, "execution-setup.json"),
            JSON.stringify(receipt),
        );
        await writeFile(join(attempt.path, "node_modules/allow-hook"), "retry");
        await f.start();
        assert.equal(await git(attempt.path, ["rev-list", "--count", `${attempt.baseCommit}..HEAD`]), "1");
    } finally {
        await f.cleanup();
    }
});

test("a configured generated hook directory requires confirmation even before hooks exist", async () => {
    const f = await fixture({ configured: false });
    try {
        await git(f.root, ["config", "core.hooksPath", "node_modules/generated-hooks"]);
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "canceled" }) });
        await assert.rejects(f.start, /setup was not confirmed/);
        assert.equal(f.session.getActiveExecutionWorkflow(), null);
        assert.equal((await listEntries(f.root)).length, 0);
    } finally {
        await f.cleanup();
    }
});

test("interrupted preparation checkpoint journals require the retained commit", async () => {
    const f = await fixture();
    try {
        const workflow = await f.start();
        const entries = await listEntries(f.root);
        const prove = buildEffectProver(f.root, {
            registryEntries: entries,
            gitWorktreePaths: entries.map((entry) => entry.path),
        });
        const proof = {
            worktreeId: workflow.worktreeId,
            preparationCommit: await git(workflow.executionCwd!, ["rev-parse", "HEAD"]),
        };
        assert.equal(
            (await prove({ effect: "execution_preparation_checkpoint_settled", proof }, { planName })).settled,
            true,
        );
        assert.equal(
            (
                await prove(
                    {
                        effect: "execution_preparation_checkpoint_settled",
                        proof: { ...proof, preparationCommit: "0000000000000000000000000000000000000000" },
                    },
                    { planName },
                )
            ).settled,
            false,
        );
    } finally {
        await f.cleanup();
    }
});

test("Stop while accepting the setup command cannot launch bootstrap", async () => {
    const f = await fixture({ configured: false });
    try {
        f.session.subscribeRuntimeEvents((event) => {
            if (event.type === "interaction_resolved") f.session.cancelActiveInteractions();
        });
        await assert.rejects(f.start, /setup canceled/);
        assert.equal(f.session.getActiveExecutionWorkflow(), null);
        assert.equal(f.session.getActiveInteractions().size, 0);
        assert.equal((await listEntries(f.root)).length, 0);
    } finally {
        await f.cleanup();
    }
});

test("declaring existing setup still preserves a failed hook for command-based recovery", async () => {
    const f = await fixture({ configured: false });
    try {
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: "" }) });
        await assert.rejects(f.start, /hook.cjs/);
        const [attempt] = await listEntries(f.root);
        assert(attempt);
        assert.equal((await readExecutionSetup(attempt.path))?.state, "ready");
        f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: "bun setup.cjs" }) });
        await f.start();
        assert.equal(await git(attempt.path, ["rev-list", "--count", `${attempt.baseCommit}..HEAD`]), "1");
    } finally {
        await f.cleanup();
    }
});
