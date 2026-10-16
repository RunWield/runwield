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
import { prepareExecutionSetup, readExecutionSetup } from "./execution-setup.ts";

import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import { getExactProjectCustomSetting, setExactProjectCustomSetting } from "../settings.js";
import {
    captureValidationSettingsWrite,
    recordValidationSettingsWrite,
    projectCommandSettingsContent,
} from "../worktree-project-context.ts";

const repo = defineCommittedGitFixture();
const planName = "dependency-hook";

async function fixture(
    options: {
        failure?: boolean;
        mutation?: boolean;
        configured?: boolean;
        ignoredSettings?: boolean;
        hookFailure?: boolean;
        hookMutation?: boolean;
        hookFormat?: boolean;
    } = {},
) {
    const root = await repo.checkout({ prefix: "execution-setup-" });
    await mkdir(join(root, ".hooks"));
    await mkdir(join(root, ".wld"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "node_modules/\n" + (options.ignoredSettings ? ".wld/\n" : ""));
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

test("a failed command correction is saved and included in the single preparation commit", async () => {
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
        assert.equal(getExactProjectCustomSetting("worktree_setup_command", f.root), "bun setup.cjs");
        assert.equal(
            JSON.parse(await git(attempt.path, ["show", "HEAD:.wld/settings.json"])).worktree_setup_command,
            "bun setup.cjs",
        );
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

test("a confirmed setup command is reused by older and fresh worktrees while preserving verification", async () => {
    const f = await fixture({ configured: false });
    try {
        const older = await createTestWorktreeAttempt({ projectRoot: f.root, planName: "older" });
        setExactProjectCustomSetting("verification_command", "bun run ci", f.root);
        const workflow = await f.start();
        assert.equal(getExactProjectCustomSetting("worktree_setup_command", f.root), "bun setup.cjs");
        assert.equal(getExactProjectCustomSetting("verification_command", f.root), "bun run ci");
        assert.equal(getExactProjectCustomSetting("verification_command", workflow.executionCwd!), "bun run ci");
        const fresh = await createTestWorktreeAttempt({ projectRoot: f.root, planName: "fresh" });
        f.session.setInteractionAdapter({
            requestInteraction: () => {
                throw new Error("Saved setup must not prompt again");
            },
        });
        for (const entry of [older, fresh]) {
            await prepareExecutionSetup(f.session, entry.path);
            assert.equal((await readExecutionSetup(entry.path))?.command, "bun setup.cjs");
            assert.equal(await readFile(join(entry.path, "node_modules/runs"), "utf8"), "run\n");
        }
    } finally {
        await f.cleanup();
    }
});

test("an explicit checkout setup override wins over the saved project default", async () => {
    const f = await fixture({ configured: false });
    try {
        const entry = await createTestWorktreeAttempt({ projectRoot: f.root, planName: "override" });
        setExactProjectCustomSetting("worktree_setup_command", "bun missing.cjs", f.root);
        setExactProjectCustomSetting("worktree_setup_command", "", entry.path);
        f.session.setInteractionAdapter({
            requestInteraction: () => {
                throw new Error("Explicit override must not prompt");
            },
        });
        await prepareExecutionSetup(f.session, entry.path);
        assert.equal((await readExecutionSetup(entry.path))?.command, "");
        assert.equal(getExactProjectCustomSetting("worktree_setup_command", f.root), "bun missing.cjs");
    } finally {
        await f.cleanup();
    }
});

test("saving setup cannot adopt unrelated settings edits in an existing worktree", async () => {
    const f = await fixture({ configured: false });
    try {
        const entry = await createTestWorktreeAttempt({ projectRoot: f.root, planName: "dirty-settings" });
        setExactProjectCustomSetting("theme", "personal-edit", entry.path);
        const before = await readFile(join(entry.path, ".wld/settings.json"), "utf8");
        await assert.rejects(() => prepareExecutionSetup(f.session, entry.path), /unrelated edits/);
        assert.equal(await readFile(join(entry.path, ".wld/settings.json"), "utf8"), before);
        assert.equal(getExactProjectCustomSetting("worktree_setup_command", f.root), undefined);
        assert.equal(await readExecutionSetup(entry.path), null);
    } finally {
        await f.cleanup();
    }
});

for (const phase of ["intent", "primary", "execution", "provenance", "unrelated-edit"] as const) {
    test(`interrupted setup command persistence recovers only its recorded settings write: ${phase}`, async () => {
        const f = await fixture({ configured: false });
        try {
            f.session.setInteractionAdapter({
                requestInteraction: () => ({ outcome: "text", value: "bun missing.cjs" }),
            });
            await assert.rejects(f.start, /Worktree setup failed/);
            const [entry] = await listEntries(f.root);
            const receipt = await readExecutionSetup(entry.path);
            assert(receipt);
            const command = "bun setup.cjs";
            const ownership = await captureValidationSettingsWrite(entry.path);
            const executionBefore = await readFile(join(entry.path, ".wld/settings.json"), "utf8");
            const settingsWrite = {
                ownership,
                executionBefore,
                executionAfter: projectCommandSettingsContent(executionBefore, command, "worktree_setup_command"),
                primaryAfter: projectCommandSettingsContent(ownership.before, command, "worktree_setup_command"),
            };
            await writeFile(
                join(resolveProjectRuntimeLayout(entry.path).selected.internalRoot, "execution-setup.json"),
                JSON.stringify({ ...receipt, command, settingsWrite }),
            );
            if (phase !== "intent") setExactProjectCustomSetting("worktree_setup_command", command, f.root);
            if (["execution", "provenance", "unrelated-edit"].includes(phase)) {
                setExactProjectCustomSetting("worktree_setup_command", command, entry.path);
            }
            if (phase === "provenance")
                await recordValidationSettingsWrite(ownership, command, "worktree_setup_command");
            if (phase === "unrelated-edit") {
                setExactProjectCustomSetting("theme", "user-edit", entry.path);
                await assert.rejects(f.start, /will not be committed as preparation/);
                assert.equal(getExactProjectCustomSetting("theme", entry.path), "user-edit");
                assert.equal(await git(entry.path, ["rev-parse", "HEAD"]), entry.baseCommit);
            } else {
                f.session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "text", value: command }) });
                await f.start();
                assert.equal((await readExecutionSetup(entry.path))?.state, "prepared");
                assert.equal(getExactProjectCustomSetting("worktree_setup_command", f.root), command);
                assert.equal(await git(entry.path, ["rev-list", "--count", `${entry.baseCommit}..HEAD`]), "1");
            }
        } finally {
            await f.cleanup();
        }
    });
}

test("ignored setup settings survive a postcommit receipt interruption without a duplicate preparation commit", async () => {
    const f = await fixture({ configured: false, ignoredSettings: true });
    try {
        const workflow = await f.start();
        const cwd = workflow.executionCwd!;
        const receipt = await readExecutionSetup(cwd);
        assert(receipt);
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        assert.equal(
            JSON.parse(await git(cwd, ["show", "HEAD:.wld/settings.json"])).worktree_setup_command,
            "bun setup.cjs",
        );
        await writeFile(
            join(resolveProjectRuntimeLayout(cwd).selected.internalRoot, "execution-setup.json"),
            JSON.stringify({ ...receipt, state: "ready" }),
        );
        f.session.setInteractionAdapter({
            requestInteraction: () => {
                throw new Error("A committed preparation must not rerun setup");
            },
        });
        await f.start();
        assert.equal(await git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal((await readExecutionSetup(cwd))?.state, "prepared");
        assert.equal(await readFile(join(cwd, "node_modules/runs"), "utf8"), "run\n");
    } finally {
        await f.cleanup();
    }
});
