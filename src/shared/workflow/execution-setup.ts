import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    parsePlanFrontMatter,
    mergeFrontMatterText,
    planDocumentMarkdown,
    type PlanFrontMatter,
} from "../../plan-store.js";
import { stripRuntimeFields } from "./controller-state.ts";
import { platform } from "node:process";
import { captureForegroundProcess } from "../captured-process.ts";
import { spawnForegroundShell } from "../foreground-process.ts";
import {
    getCustomSetting,
    getExactProjectCustomSetting,
    setCustomSetting,
    setExactProjectCustomSetting,
} from "../settings.js";
import {
    captureValidationSettingsWrite,
    recordValidationSettingsWrite,
    type ValidationSettingsWrite,
    readProjectContextFile,
    readProjectContextRevision,
    isTransferredProjectContext,
    projectCommandSettingsContent,
    recordedProjectContextPaths,
} from "../worktree-project-context.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import type { HostedSession } from "../session/hosted-session.js";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from "../session/session-runtime-interactions.js";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { captureWorktreeTree } from "./git-snapshot.ts";
import {
    captureProcessStreamTail,
    formatCapturedProcessOutput,
    PROCESS_STREAM_OUTPUT_LIMIT_BYTES,
} from "./process-output.ts";

interface SetupLifecyclePlan {
    path: string;
    expected: string;
}

interface SetupSettingsWrite {
    ownership: ValidationSettingsWrite;
    executionBefore: string | null;
    executionAfter: string;
    primaryAfter: string;
}

interface SetupReceipt {
    state: "pending" | "ready" | "prepared";
    command: string;
    commitToken: string;
    head: string;
    tree: string;
    index: string;
    checkpointTree?: string;
    lifecyclePlan?: SetupLifecyclePlan;
    settingsWrite?: SetupSettingsWrite;
    settingsContent?: string | null;
}

function receiptPath(cwd: string): string {
    return join(resolveProjectRuntimeLayout(cwd).selected.internalRoot, "execution-setup.json");
}

export async function readExecutionSetup(cwd: string): Promise<SetupReceipt | null> {
    try {
        const receipt: SetupReceipt = JSON.parse(await readFile(receiptPath(cwd), "utf8"));
        if (
            !["pending", "ready", "prepared"].includes(receipt.state) ||
            [receipt.command, receipt.commitToken, receipt.head, receipt.tree, receipt.index].some(
                (value) => typeof value !== "string",
            )
        ) {
            throw new Error(`Invalid worktree setup receipt at ${receiptPath(cwd)}; execution remains paused.`);
        }
        return receipt;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function writeReceipt(cwd: string, receipt: SetupReceipt): Promise<void> {
    const path = receiptPath(cwd);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt) + "\n");
    await rename(temporary, path);
}

async function git(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (output.code !== 0) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
}

async function hasCommitHooks(cwd: string): Promise<boolean> {
    const configured = await captureForegroundProcess("git", { cwd, args: ["config", "--get", "core.hooksPath"] });
    if (configured.code === 0 && new TextDecoder().decode(configured.stdout).trim()) return true;
    if (configured.code !== 0 && configured.code !== 1) throw new Error(new TextDecoder().decode(configured.stderr));
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg"]) {
        const path = await git(cwd, ["rev-parse", "--git-path", `hooks/${hook}`]);
        try {
            await access(resolve(cwd, path), platform === "win32" ? constants.F_OK : constants.X_OK);
            return true;
        } catch (error) {
            if (error instanceof Error && "code" in error && ["ENOENT", "EACCES"].includes(String(error.code)))
                continue;
            throw error;
        }
    }
    return false;
}

interface SetupSelection {
    command: string;
    confirmed: boolean;
}

async function selectSetupCommand(session: HostedSession, cwd: string): Promise<SetupSelection | null> {
    const exact = getExactProjectCustomSetting("worktree_setup_command", cwd);
    const configured = typeof exact === "string" ? exact : getCustomSetting("worktree_setup_command", "project", cwd);
    if (typeof configured === "string") return { command: configured.trim(), confirmed: false };
    if (!(await hasCommitHooks(cwd))) return null;
    const response = await requestHostedSessionInteraction(
        session,
        {
            type: RuntimeInteractionTypes.TEXT,
            prompt: `This worktree has Git commit hooks. Enter the project's approved setup command to prepare their dependencies in ${cwd}, or leave empty if this project needs no setup in fresh worktrees. Your answer will be saved in .wld/settings.json for future worktrees. Cancel to pause execution. RunWield will not choose an installer automatically.`,
            allowEmpty: true,
        },
        undefined,
        session.getManagedOperationCapability?.() || null,
    );
    if (response.outcome !== "text") throw new Error("Worktree setup was not confirmed; no Agent work began.");
    return { command: String(response.value || "").trim(), confirmed: true };
}

async function snapshot(cwd: string) {
    return {
        head: await git(cwd, ["rev-parse", "HEAD"]),
        tree: await captureWorktreeTree(cwd),
        index: await git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"]),
        settingsContent: await readProjectContextFile(cwd, ".wld/settings.json"),
    };
}

async function assertSetupFilesUnchanged(cwd: string, receipt: SetupReceipt) {
    const current = await snapshot(cwd);
    const allowedTrees = [receipt.tree, ...(receipt.checkpointTree ? [receipt.checkpointTree] : [])];
    if (receipt.state === "ready" && receipt.lifecyclePlan && !allowedTrees.includes(current.tree)) {
        const changedPaths = await git(cwd, ["diff", "--name-only", receipt.tree, current.tree]);
        if (changedPaths === receipt.lifecyclePlan.path) {
            const currentPlan = await readFile(join(cwd, receipt.lifecyclePlan.path), "utf8");
            if (
                isDeepStrictEqual(
                    parsePlanFrontMatter(currentPlan),
                    parsePlanFrontMatter(receipt.lifecyclePlan.expected),
                )
            ) {
                allowedTrees.push(current.tree);
            }
        }
    }
    if (
        receipt.settingsWrite &&
        !allowedTrees.includes(current.tree) &&
        (await git(cwd, ["diff", "--name-only", receipt.tree, current.tree])) === ".wld/settings.json" &&
        (await readProjectContextFile(cwd, ".wld/settings.json")) === receipt.settingsWrite.executionAfter
    ) {
        allowedTrees.push(current.tree);
    }
    const preparationStaged = receipt.state === "ready" && allowedTrees.includes(await git(cwd, ["write-tree"]));
    if (
        (receipt.settingsContent !== undefined &&
            current.settingsContent !== receipt.settingsContent &&
            current.settingsContent !== receipt.settingsWrite?.executionAfter) ||
        current.head !== receipt.head ||
        !allowedTrees.includes(current.tree) ||
        (current.index !== receipt.index && !preparationStaged)
    ) {
        throw new Error(
            `Worktree setup changed versioned or unignored files, staging, or HEAD in ${cwd}. ` +
                "The files are preserved; reconcile those changes before retrying. They will not be committed as preparation.",
        );
    }
    return current;
}

/** Finish only the exact recorded host write, including after a process interruption. */
async function finishSettingsWrite(cwd: string, receipt: SetupReceipt): Promise<SetupReceipt> {
    const intent = receipt.settingsWrite;
    if (!intent) return receipt;
    await assertSetupFilesUnchanged(cwd, receipt);
    const path = ".wld/settings.json";
    const primary = await readProjectContextFile(intent.ownership.primaryRoot, path);
    const execution = await readProjectContextFile(cwd, path);
    if (
        (primary !== intent.ownership.before && primary !== intent.primaryAfter) ||
        (execution !== intent.executionBefore && execution !== intent.executionAfter)
    ) {
        throw new Error(
            "Project settings changed during setup command saving; files are preserved and execution remains paused.",
        );
    }
    if (primary !== intent.primaryAfter)
        await setCustomSetting("worktree_setup_command", receipt.command, "project", cwd);
    if (execution !== intent.executionAfter)
        setExactProjectCustomSetting("worktree_setup_command", receipt.command, cwd);
    if (
        (await readProjectContextFile(intent.ownership.primaryRoot, path)) !== intent.primaryAfter ||
        (await readProjectContextFile(cwd, path)) !== intent.executionAfter
    ) {
        throw new Error(
            "Project settings changed during setup command saving; files are preserved and execution remains paused.",
        );
    }
    await recordValidationSettingsWrite(intent.ownership, receipt.command, "worktree_setup_command");
    // Revalidate after asynchronous settings and provenance writes. Never accept a
    // fresh unrestricted snapshot that could absorb edits made while saving.
    const current = await assertSetupFilesUnchanged(cwd, receipt);
    const next = { ...receipt, settingsWrite: undefined, ...current };
    await writeReceipt(cwd, next);
    return next;
}

async function captureSettingsWrite(cwd: string, command: string): Promise<SetupSettingsWrite> {
    const path = ".wld/settings.json";
    const executionBefore = await readProjectContextFile(cwd, path);
    if (
        executionBefore !== (await readProjectContextRevision(cwd, "HEAD", path)) &&
        !(await isTransferredProjectContext(cwd, path))
    ) {
        throw new Error(
            "Worktree settings contain unrelated edits; they are preserved and will not be committed as preparation.",
        );
    }
    const ownership = await captureValidationSettingsWrite(cwd);
    return {
        ownership,
        executionBefore,
        executionAfter: projectCommandSettingsContent(executionBefore, command, "worktree_setup_command"),
        primaryAfter: projectCommandSettingsContent(ownership.before, command, "worktree_setup_command"),
    };
}

/** Run only explicit project configuration or an interactive answer, before lifecycle writes or Git hooks. */
export async function prepareExecutionSetup(session: HostedSession, cwd: string): Promise<void> {
    await enterProjectRuntime(cwd);
    const saved = await readExecutionSetup(cwd);
    const previous = saved ? await finishSettingsWrite(cwd, saved) : null;
    if (previous?.state === "prepared") return;
    const interactionId = `execution-setup:${crypto.randomUUID()}`;
    const controller = new AbortController();
    session.addActiveInteraction(interactionId, { abortController: controller });
    try {
        if (previous) await assertSetupFilesUnchanged(cwd, previous);
        let selection: SetupSelection | null;
        if (previous) {
            // Retry is also the repair path for a mistyped or obsolete command.
            const response = await requestHostedSessionInteraction(
                session,
                {
                    type: RuntimeInteractionTypes.TEXT,
                    prompt: `Worktree setup did not complete in ${cwd}. Confirm or correct the setup command to retry and save it in .wld/settings.json. Empty means no setup is required for fresh worktrees. Cancel to keep execution paused.`,
                    defaultValue: previous.command,
                    allowEmpty: true,
                },
                undefined,
                session.getManagedOperationCapability?.() || null,
            );
            if (response.outcome !== "text") {
                throw new Error("Worktree setup retry was not confirmed; execution remains paused.");
            }
            selection = { command: String(response.value || "").trim(), confirmed: true };
        } else {
            selection = await selectSetupCommand(session, cwd);
        }
        if (controller.signal.aborted) throw new Error("Worktree setup canceled; no Agent work began.");
        if (selection === null) return;
        const { command } = selection;
        if (previous) await assertSetupFilesUnchanged(cwd, previous);
        let receipt: SetupReceipt = {
            state: "pending",
            command,
            commitToken: previous?.commitToken ?? crypto.randomUUID(),
            ...(await snapshot(cwd)),
            ...(selection.confirmed ? { settingsWrite: await captureSettingsWrite(cwd, command) } : {}),
        };
        // Persist the exact command-only write before touching either settings file.
        // A crash can then complete it without adopting unrelated settings edits.
        await writeReceipt(cwd, receipt);
        receipt = await finishSettingsWrite(cwd, receipt);
        if (!command) {
            await writeReceipt(cwd, { ...receipt, state: "ready" });
            if (controller.signal.aborted) throw new Error("Worktree setup canceled; no Agent work began.");
            return;
        }
        emitSystemStatus(session, `Preparing worktree dependencies: ${command}`);
        const process = spawnForegroundShell({ command, cwd, signal: controller.signal });
        const [outcome, stdout, stderr] = await Promise.all([
            process.done,
            captureProcessStreamTail(process.stdout, PROCESS_STREAM_OUTPUT_LIMIT_BYTES),
            captureProcessStreamTail(process.stderr, PROCESS_STREAM_OUTPUT_LIMIT_BYTES),
        ]);
        const output = formatCapturedProcessOutput(stdout, stderr).trim();
        if (output) emitSystemStatus(session, output);
        if (controller.signal.aborted || outcome.terminatedBy !== null || outcome.exitCode !== 0) {
            throw new Error(
                `Worktree setup ${outcome.terminatedBy !== null || controller.signal.aborted ? "canceled" : `failed (exit ${outcome.exitCode})`}. ` +
                    `No Agent work began. Files are preserved at ${cwd}; retry execution after correcting setup.\n${output}`,
            );
        }
        await assertSetupFilesUnchanged(cwd, receipt);
        await writeReceipt(cwd, { ...receipt, state: "ready" });
        if (controller.signal.aborted) throw new Error("Worktree setup canceled; no Agent work began.");
    } finally {
        session.removeActiveInteraction(interactionId);
    }
}

export async function completeExecutionSetup(cwd: string): Promise<void> {
    const receipt = await readExecutionSetup(cwd);
    if (receipt) await writeReceipt(cwd, { ...receipt, state: "prepared" });
}

/** Check before Plan reconciliation can normalize changes left by a failed hook. */
export async function assertExecutionSetupRetrySafe(cwd: string): Promise<void> {
    const saved = await readExecutionSetup(cwd);
    if (!saved || saved.state === "prepared") return;
    const receipt = await finishSettingsWrite(cwd, saved);
    // The unique token is written before Git invokes hooks and included in the
    // commit. Hooks may format those files, so prove the owned commit and path
    // boundary rather than demanding the pre-hook bytes survived unchanged.
    if (receipt.state === "ready" && receipt.checkpointTree) {
        const current = await snapshot(cwd);
        const expectedPaths = new Set(
            (await git(cwd, ["diff", "--name-only", receipt.head, receipt.checkpointTree])).split("\n"),
        );
        const committedPaths = (await git(cwd, ["diff", "--name-only", receipt.head, "HEAD"])).split("\n");
        if (
            current.head !== receipt.head &&
            (await git(cwd, ["show", "-s", "--format=%P", "HEAD"])) === receipt.head &&
            (await git(cwd, ["show", "-s", "--format=%B", "HEAD"]))
                .split("\n")
                .includes(`RunWield-Preparation: ${receipt.commitToken}`) &&
            (await git(cwd, ["rev-parse", "HEAD^{tree}"])) === current.tree &&
            (await git(cwd, ["write-tree"])) === current.tree &&
            committedPaths.every((path) => expectedPaths.has(path))
        ) {
            await writeReceipt(cwd, { ...receipt, state: "prepared" });
            return;
        }
    }
    await assertSetupFilesUnchanged(cwd, receipt);
}

/** Only the host's known Plan/lifecycle edits may extend the setup baseline before hooks run. */
export async function recordExecutionSetupCheckpoint(cwd: string): Promise<string | undefined> {
    const receipt = await readExecutionSetup(cwd);
    if (!receipt) return undefined;
    if (receipt.state === "prepared") return receipt.commitToken;
    const forcedPaths: string[] = [];
    for (const path of await recordedProjectContextPaths(cwd)) {
        if (await isTransferredProjectContext(cwd, path)) forcedPaths.push(path);
    }
    await writeReceipt(cwd, { ...receipt, checkpointTree: await captureWorktreeTree(cwd, forcedPaths) });
    return receipt.commitToken;
}

/** Persist the exact host-owned lifecycle intent before its document write. */
export async function recordExecutionSetupLifecycle(
    cwd: string,
    path: string,
    updates: Partial<PlanFrontMatter>,
): Promise<void> {
    const receipt = await readExecutionSetup(cwd);
    if (!receipt) return;
    const before = await readFile(join(cwd, path), "utf8");
    const expected = planDocumentMarkdown(mergeFrontMatterText(before, stripRuntimeFields(updates)));
    await writeReceipt(cwd, { ...receipt, lifecyclePlan: { path, expected } });
}
