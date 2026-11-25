import {
    mkdir as fsMkdir,
    readFile as fsReadFile,
    readdir as fsReaddir,
    rename as fsRename,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { JsonRecord, JsonValue } from "../src/shared/jsonc.ts";
import type { PublicationPhase } from "@runwield/workflow/publication";

const evidenceDirectory = /^runwield-golden-tui-(?:timeout|child-failure|failure)-[a-z0-9]+$/i;
const safeLabel = /^[a-z0-9_-]{1,120}$/i;
const knownErrorPrefixes = [
    "Timed out waiting for TUI composition idle",
    "Timed out waiting for published Plan",
    "Timed out waiting for execution Plan",
    "Timed out waiting for Plan",
    "Timed out waiting for scripted Runtime interactions",
    "Timed out waiting for screen marker",
    "Timed out waiting for",
    "TUI did not restart before scripted input",
    "Unknown composed scenario action",
    "Golden publication Git show failed",
    "Golden publication Git merge-base failed",
    "Expected a confirmed Git delivery receipt",
    "Published copy differs from the sealed input",
];
const startupPhases = new Set([
    "loading init state",
    "loading scenario runner",
    "loading scenario",
    "starting scenario",
    "cleaning isolated environment",
]);

const runtimeEventKinds = new Set([
    "agent_changed",
    "busy_changed",
    "cancellation",
    "interaction_resolved",
    "managed_sync_state_changed",
    "queued_message_changed",
    "system_status",
    "tool_end",
    "tool_start",
    "turn_end",
    "turn_start",
    "workflow_context_changed",
    "validation-ci:started",
    "validation-ci:passed",
    "validation-ci:failed",
]);
const diagnosticToolNames = new Set([
    "bash",
    "manual_qa_completed",
    "review_complete",
    "review_diff",
    "task_completed",
    "work_record_completed",
]);

function safeEvent(value: JsonValue): string | undefined {
    if (typeof value !== "string") return undefined;
    const base = /^(runtime|concurrent:[a-zA-Z0-9_-]+:runtime):(.*)$/.exec(value);
    if (!base) return undefined;
    const scope = base[1] === "runtime" ? "runtime:" : "concurrent:runtime:";
    const kind = base[2];
    if (runtimeEventKinds.has(kind)) return scope + kind;
    const tool = /^tool:(start|end|result):([a-z_]+)(?::(?:ok|error))?$/.exec(kind);
    return tool && diagnosticToolNames.has(tool[2]) ? scope + kind : undefined;
}

// Keep a separate completion trace per terminal so a busy peer cannot evict it.
function completionTraces(value: JsonValue | undefined, secondaryLanes: string[]) {
    const lanes = ["runtime", ...secondaryLanes.map((lane) => `concurrent:${lane}:runtime`)];
    const traces = new Map(lanes.map((lane) => [lane, [] as string[]]));
    if (!Array.isArray(value)) return undefined;
    for (const event of value) {
        if (typeof event !== "string") continue;
        const match = /^(runtime|concurrent:[a-zA-Z0-9_-]+:runtime):(.*)$/.exec(event);
        if (!match) continue;
        const [, lane, kind] = match;
        const trace = traces.get(lane);
        if (!trace) continue;
        if (
            /^tool:(?:start:(?:bash|task_completed|review_complete)|result:(?:bash|task_completed|review_complete):(?:ok|error))$/.test(
                kind,
            ) ||
            /^fixture-route:(?:unassigned|actor-rejected|reviewer-matched)$/.test(kind) ||
            /^completion:(?:tool-accepted|tool-rejected|tool-other|engineer-unfinished|checkpoint-failed)$/.test(
                kind,
            ) ||
            kind === "validation-ci:started"
        ) {
            trace.push(kind);
            if (trace.length > 16) trace.shift();
        }
    }
    // Export only fixed event labels in primary/secondary order, no lane names.
    return [...traces.values()];
}

function record(value: JsonValue | undefined): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function parsed(value: string): JsonRecord {
    try {
        return record(JSON.parse(value));
    } catch {
        return {};
    }
}
function label(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" && safeLabel.test(value) ? value : undefined;
}
function errorCategory(value: JsonValue | undefined): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    return knownErrorPrefixes.find((prefix) => value.startsWith(prefix)) ?? "other error (message omitted)";
}
function count(value: JsonValue | undefined): number | undefined {
    return Array.isArray(value) ? value.length : undefined;
}
function flag(value: JsonValue | undefined): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}
function integer(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

const planStatuses = [
    "draft",
    "approved",
    "ready_for_work",
    "in_progress",
    "implemented",
    "validated_ci",
    "reviewed",
    "validated",
    "verified",
    "user_verified",
    "on_hold",
];
const validationStages = [
    "cycle",
    "ci",
    "engineer_repair",
    "semantic_review",
    "human_review",
    "merge",
    "manual_qa",
    "terminal",
];
const validationOutcomes = ["running", "paused", "verified", "failed"];
const publicationPhases = [
    "candidate_sealed",
    "artifacts_committed",
    "target_integrated",
    "target_published",
    "publication_verified",
    "cleanup_complete",
] as const satisfies readonly PublicationPhase[];
const checkStates = ["pending", "running", "passed", "failed", "skipped", "canceled"];

function enumValue(value: JsonValue | undefined, accepted: readonly string[]): string | undefined {
    return typeof value === "string" && accepted.includes(value) ? value : undefined;
}

// The named secondary Session need not share the primary's terminal status.
// Keep its state but not its alias, Plan identity, screen, notices or messages.
function concurrentRuntime(value: JsonRecord) {
    const runtime = record(value.runtime);
    const context = record(runtime.workflowContext);
    const progress = record(context.validationProgress);
    const checks = record(progress.checks);
    const facts = Array.isArray(context.progressFacts) ? context.progressFacts.map(record) : [];
    const publication = facts.findLast((fact) => fact.kind === "publication");
    const checkpoint = facts.findLast((fact) => fact.kind === "validation_checkpoint");
    return {
        busy: flag(runtime.busy),
        activeTurn: runtime.activeTurnId === null ? false : typeof runtime.activeTurnId === "string" || undefined,
        liveQuestion: flag(context.liveQuestion),
        livePlanReview: flag(context.livePlanReview),
        liveCodeReview: flag(context.liveCodeReview),
        planStatus: enumValue(context.status, planStatuses),
        validationStage: enumValue(progress.stage, validationStages),
        validationOutcome: enumValue(progress.outcome, validationOutcomes),
        ci: enumValue(checks.ci, checkStates),
        semanticReview: enumValue(checks.semanticReview, checkStates),
        humanReview: enumValue(checks.humanReview, checkStates),
        merge: enumValue(checks.merge, checkStates),
        publicationPhase: enumValue(publication?.phase, publicationPhases),
        publicationFailed: flag(publication?.failure),
        checkpointPhase: enumValue(checkpoint?.phase, ["mechanical", "semantic", "delivery"]),
        checkpointState: enumValue(checkpoint?.state, ["ready", "running", "awaiting_repair", "paused"]),
    };
}

function diagnostic(value: JsonRecord, startupPhase: string) {
    const runtime = record(value.runtime);
    const context = record(runtime.workflowContext);
    const progress = record(context.validationProgress);
    const checks = record(progress.checks);
    const actor = record(value.actor);
    const child = record(value.childPayload);
    const observation = record(value.lastPlanObservation);
    const concurrent = Object.entries(record(value.concurrentSessions)).slice(0, 4);
    const lastValidation =
        typeof value.validationErrors === "string"
            ? value.validationErrors
                  .trim()
                  .split("\n")
                  .slice(-10)
                  .map(parsed)
                  .findLast((row) => row.name)
            : undefined;
    const events = Array.isArray(value.events)
        ? value.events
              .map(safeEvent)
              .filter((event) => event !== undefined)
              .slice(-32)
        : undefined;
    return {
        scenario: label(value.scenario) ?? label(value.exportName),
        startupPhase: startupPhases.has(startupPhase) ? startupPhase : undefined,
        currentAction: label(value.currentAction),
        actionIndex: integer(value.actionIndex),
        childPid: integer(value.pid),
        childReady: flag(value.ready),
        childExit: integer(value.code),
        timedOut: flag(value.timedOut),
        error: errorCategory(value.error ?? child.error),
        planObservation: {
            executionStatus: label(observation.executionStatus),
            remoteStatus: label(observation.remoteStatus),
            localStatus: label(observation.localStatus),
            registry: label(observation.registryStatus),
            lookupError: errorCategory(observation.lookupError),
        },
        lastValidationError: lastValidation
            ? { type: label(lastValidation.name), operation: label(lastValidation.operation) }
            : undefined,
        runtime: {
            agent: label(runtime.activeAgent),
            busy: flag(runtime.busy),
            activeTurn: runtime.activeTurnId === null ? false : typeof runtime.activeTurnId === "string" || undefined,
            liveQuestion: flag(context.liveQuestion),
            liveReview: flag(context.livePlanReview) ?? flag(context.liveCodeReview),
            queued: count(runtime.queuedMessages),
            planStatus: label(context.status),
            validationStage: label(progress.stage),
            validationOutcome: label(progress.outcome),
            ci: label(checks.ci),
            semanticReview: label(checks.semanticReview),
            humanReview: label(checks.humanReview),
            merge: label(checks.merge),
        },
        concurrentSessions: concurrent.length
            ? concurrent.map(([, entry]) => concurrentRuntime(record(entry)))
            : undefined,
        completionTraces: completionTraces(
            value.events,
            concurrent.map(([lane]) => lane),
        ),
        actor: { consumed: count(actor.consumed), remaining: count(actor.remaining) },
        events,
    };
}

async function writeShareableEvidence(source: string, destination: string): Promise<void> {
    const phase = await fsReadFile(join(source, "startup-phase.txt"), "utf8")
        .then((value) => value.trim())
        .catch(() => "");
    const entries = await fsReaddir(source, { withFileTypes: true });
    const summary: Record<string, ReturnType<typeof diagnostic>> = {};
    for (const entry of entries) {
        if (entry.isFile() && (entry.name === "timeout-diagnostics.json" || entry.name === "child-diagnostics.json")) {
            const data = parsed(await fsReadFile(join(source, entry.name), "utf8"));
            summary[entry.name] = diagnostic(data, phase);
        } else if (entry.isDirectory() && evidenceDirectory.test(entry.name)) {
            const childPath = join(source, entry.name, "diagnostics.json");
            const data = await fsReadFile(childPath, "utf8")
                .then(parsed)
                .catch(() => undefined);
            if (data) summary["failure-diagnostics.json"] = diagnostic(data, phase);
        }
    }
    if (Object.keys(summary).length === 0 && !phase) return;
    if (Object.keys(summary).length === 0) summary["phase"] = diagnostic({}, phase);
    await fsMkdir(join(destination, ".."), { recursive: true });
    await fsWriteFile(destination, JSON.stringify(summary, null, 2) + "\n");
}

/** Keep full Golden diagnostics only in local scratch; CI gets a field-limited summary. */
export async function retainTestEvidence(
    sandbox: string,
    localDestination: string | undefined,
    shareableDestination?: string,
): Promise<void> {
    for await (const slot of await fsReaddir(sandbox, { withFileTypes: true })) {
        if (!slot.isDirectory()) continue;
        const temp = slot.name.startsWith("tmp-") ? join(sandbox, slot.name) : join(sandbox, slot.name, "tmp");
        const entries = await fsReaddir(temp, { withFileTypes: true }).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
        });
        for (const entry of entries) {
            if (!entry.isDirectory() || !evidenceDirectory.test(entry.name)) continue;
            const source = join(temp, entry.name);
            if (shareableDestination) {
                await writeShareableEvidence(source, join(shareableDestination, entry.name + ".json")).catch((error) =>
                    console.error(
                        "Could not retain sanitized test evidence:",
                        error instanceof Error ? error.name : "error",
                    ),
                );
            }
            if (localDestination) {
                await fsMkdir(localDestination, { recursive: true });
                await fsRename(source, join(localDestination, entry.name));
            }
        }
    }
}
