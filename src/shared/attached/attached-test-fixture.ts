import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { rm as fsRm, readFile as fsReadFile } from "node:fs/promises";
import { spawnNativeProcess } from "../foreground-process.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { savePlan } from "../../plan-store.js";
import { runAttachedOperation } from "./coordinator.ts";
import { type AttachedJsonObject, type AttachedOperationName, type AttachedOperationResult } from "./operations.ts";
import { locateAttachedWorkflows } from "./record-store.ts";
import process from "node:process";

/**
 * @module shared/attached/attached-test-fixture
 * Operation inputs and a real `wld attached` subprocess runner for Attached tests.
 */

export const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));
export const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
export const DENO_CONFIG_PATH = join(REPO_ROOT, "deno.json");

/** An uninitialized Project: one commit, no `.wld/`, no `.gitignore`. */
export const projectFixture = defineCommittedGitFixture({ "README.md": "# Fixture\n" });

export const EVIDENCE = { host: "claude-code", hostVersion: "2.1.0", adapterVersion: "0.1.0" };

export function activateInput(operationId = "op-activate"): AttachedJsonObject {
    return {
        operationId,
        evidence: EVIDENCE,
        payload: { requestText: "Add a dark mode toggle", hostRequestId: "host-request-1" },
    };
}

export interface TriageReportInputOptions {
    workflowId: string;
    actionId: string;
    expectedRevision?: number;
    operationId?: string;
    outcome?: AttachedJsonObject;
}

export function triageReportInput(options: TriageReportInputOptions): AttachedJsonObject {
    return {
        operationId: options.operationId ?? "op-triage-report",
        workflowId: options.workflowId,
        expectedRevision: options.expectedRevision ?? 1,
        evidence: EVIDENCE,
        payload: {
            actionId: options.actionId,
            outcome: options.outcome ?? {
                routingIntent: "PLANNED_CHANGE",
                workKind: "FEATURE",
                complexity: "MEDIUM",
                summary: "Add a toggle",
            },
        },
    };
}

/** The Triage action an accepted activation handed to the host. */
export function pendingTriage(result: AttachedOperationResult): { workflowId: string; actionId: string } {
    if (!result.ok || result.workflow.nextAction.kind !== "triage") {
        throw new Error(`Expected a pending Triage action, got ${JSON.stringify(result)}`);
    }
    return { workflowId: result.workflow.workflowId, actionId: result.workflow.nextAction.actionId };
}

export function rejectionCode(result: AttachedOperationResult): string | null {
    return result.ok ? null : result.rejection.code;
}

/** Run one operation in-process through the same text entry the carriers use. */
export function runOperation(name: AttachedOperationName, projectRoot: string, input: AttachedJsonObject) {
    return runAttachedOperation(name, projectRoot, JSON.stringify(input));
}

export async function withProject(fn: (projectRoot: string) => Promise<void>): Promise<void> {
    const projectRoot = await projectFixture.checkout({ prefix: "runwield-attached-" });
    try {
        await fn(projectRoot);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => undefined);
    }
}

export interface PendingPlanning {
    workflowId: string;
    actionId: string;
    expectedRevision: number;
}

/** Activate and report a PLANNED_CHANGE FEATURE Triage outcome; returns the pending Planner action. */
export async function reachPlanning(projectRoot: string, triageOperationId = "op-triage-report") {
    const triage = pendingTriage(await runOperation("activate", projectRoot, activateInput()));
    const result = await runOperation(
        "triage_report",
        projectRoot,
        triageReportInput({ ...triage, operationId: triageOperationId }),
    );
    if (!result.ok || result.workflow.nextAction.kind !== "plan") {
        throw new Error(`Expected a pending Planner action, got ${JSON.stringify(result)}`);
    }
    const planning: PendingPlanning = {
        workflowId: result.workflow.workflowId,
        actionId: result.workflow.nextAction.actionId,
        expectedRevision: result.workflow.revision,
    };
    return { result, planning };
}

export interface PlanWrittenInputOptions extends PendingPlanning {
    planName?: string;
    operationId?: string;
    executionAgent?: string;
    collaborationRecommendation?: string;
}

export function planWrittenInput(options: PlanWrittenInputOptions): AttachedJsonObject {
    const payload: AttachedJsonObject = {
        actionId: options.actionId,
        planName: options.planName ?? "dark-mode-toggle",
    };
    if (options.executionAgent !== undefined) payload.executionAgent = options.executionAgent;
    if (options.collaborationRecommendation !== undefined) {
        payload.collaborationRecommendation = options.collaborationRecommendation;
    }
    return {
        operationId: options.operationId ?? "op-plan-written",
        workflowId: options.workflowId,
        expectedRevision: options.expectedRevision,
        evidence: EVIDENCE,
        payload,
    };
}

export async function readRecordBytes(projectRoot: string, workflowId: string): Promise<string> {
    return await fsReadFile(join(locateAttachedWorkflows(projectRoot).workflowsDir, `${workflowId}.json`), "utf8");
}

export interface CliRun {
    code: number;
    result: AttachedOperationResult;
    stderr: string;
}

/** Spawn a fresh `wld attached <operation>` Core process in `projectRoot`. */
export async function spawnAttachedCli(
    operation: AttachedOperationName,
    projectRoot: string,
    input: AttachedJsonObject,
): Promise<CliRun> {
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--no-check",
            "--config",
            DENO_CONFIG_PATH,
            CLI_PATH,
            "attached",
            operation,
        ]),
        cwd: projectRoot,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(input)));
    await writer.close();
    const finished = await collectProcessOutput(child);
    const stdout = new TextDecoder().decode(finished.stdout);
    const stderr = new TextDecoder().decode(finished.stderr);
    try {
        const result: AttachedOperationResult = JSON.parse(stdout);
        return { code: finished.code, result, stderr };
    } catch {
        throw new Error(`wld attached ${operation} printed no JSON result.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
}

/** Submit one FEATURE Plan through the real coordinator and return its pending review. */
export async function submitReview(projectRoot: string) {
    const { planning } = await reachPlanning(projectRoot);
    await savePlan(projectRoot, "dark-mode-toggle", "# Toggle\n\nAdd a toggle.\n", {
        classification: "PLANNED_CHANGE",
        executionAgent: "engineer",
        collaborationRecommendation: "pair",
    });
    const submitted = await runOperation("plan_written", projectRoot, planWrittenInput(planning));
    if (!submitted.ok) throw new Error(JSON.stringify(submitted));
    return submitted.workflow;
}
