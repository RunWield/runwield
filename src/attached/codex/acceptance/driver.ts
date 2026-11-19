import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectEvidence, assessHandshake } from "./collector.ts";
import { AcceptanceWorld, PrerequisiteError, type WorldOptions } from "./world.ts";
import { field, type AcceptanceSummary, type Check, type JsonMap } from "./evidence.ts";

export interface AcceptanceOptions extends WorldOptions {
    keep: boolean;
}
const EXPECTED_TOOLS = [
    "activate",
    "triage_report",
    "review_reply",
    "status",
    "plan_written",
    "start_execution",
    "task_completed",
    "start_validation",
    "review_diff",
    "review_complete",
    "validation_decision",
    "work_record_completed",
    "get_instructions",
    "get_artifact",
    "get_pending_chat",
].sort();
function requireCheck(checks: Check[], id: string, condition: boolean, detail: string): void {
    checks.push({ id, outcome: condition ? "pass" : "fail", detail });
    if (!condition) throw new Error(`Acceptance check failed: ${id}`);
}
function identity(body: JsonMap): JsonMap {
    return {
        workflowId: field(body, "workflow", "workflowId"),
        revision: field(body, "workflow", "revision"),
        actionId: field(body, "workflow", "nextAction", "actionId"),
        kind: field(body, "workflow", "nextAction", "kind"),
    };
}
/** Installed native protocol qualification. Explicitly does not certify model/skill or desktop UI behavior. */
export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceSummary> {
    const world = new AcceptanceWorld(options);
    await world.create();
    const summary: AcceptanceSummary = {
        schemaVersion: 1,
        outcome: "blocked",
        scope: "installed-protocol",
        surface: "desktop-runtime",
        hostVersion: null,
        permissions: "protocol-tools-in-disposable-world",
        testDate: new Date().toISOString(),
        source: null,
        adapterVersion: null,
        adapterContract: null,
        blockedPrerequisite: null,
        checks: [],
        limitations: [
            "Native Codex app-server protocol only; no model calls, skill invocation, or desktop UI acceptance.",
            "CLI skill execution and fresh independent reviewer coverage require separate live evidence.",
            "This result cannot create a tested-version compatibility entry.",
        ],
        proposedMatrixEntry: null,
    };
    let prepared = false;
    try {
        Object.assign(summary, await world.prepare());
        prepared = true;
        await world.install();
        summary.checks.push({
            id: "native-install",
            outcome: "pass",
            detail: "The real Codex CLI installed the copied package in disposable configuration.",
        });
        let host = world.protocolHost("initial");
        await host.initialize();
        const inventory = await host.inventory();
        const rows = Array.isArray(inventory.data) ? inventory.data : [];
        const server = rows.find((row) => field(row, "name") === "runwield");
        const tools = field(server, "tools");
        requireCheck(
            summary.checks,
            "native-tool-discovery",
            field(server, "runtimeStatus") === "connected" &&
                tools !== null &&
                typeof tools === "object" &&
                !Array.isArray(tools) &&
                JSON.stringify(Object.keys(tools).sort()) === JSON.stringify(EXPECTED_TOOLS),
            "Installed RunWield exposes the complete coordinator tool contract.",
        );
        const empty = await host.call("status", {});
        requireCheck(
            summary.checks,
            "inactive-before",
            empty.ok === false && field(empty, "rejection", "code") === "workflow_not_found",
            "Installing the plugin does not activate a workflow.",
        );
        const activated = await host.call("activate", {
            operationId: randomUUID(),
            payload: {
                requestText: "Add a portable greeting command with focused tests.",
                hostRequestId: randomUUID(),
            },
        });
        const start = identity(activated);
        requireCheck(
            summary.checks,
            "activation",
            activated.ok === true && start.kind === "triage",
            "Actual Codex MCP activation reaches Core triage.",
        );
        const envelope = {
            workflowId: start.workflowId,
            expectedRevision: start.revision,
            payload: {
                actionId: start.actionId,
                outcome: {
                    routingIntent: "PLANNED_CHANGE",
                    workKind: "FEATURE",
                    complexity: "LOW",
                    summary: "Add a greeting command.",
                },
            },
        };
        const stale = await host.call("triage_report", {
            ...envelope,
            operationId: randomUUID(),
            expectedRevision: Number(start.revision) + 1,
        });
        requireCheck(
            summary.checks,
            "stale-revision",
            field(stale, "rejection", "code") === "revision_conflict",
            "Core rejects stale lifecycle submissions from Codex.",
        );
        const transcript = await host.call("triage_report", {
            ...envelope,
            operationId: randomUUID(),
            payload: { ...envelope.payload, messages: [world.sentinel] },
        });
        requireCheck(
            summary.checks,
            "transcript-rejection",
            field(transcript, "rejection", "code") === "transcript_field",
            "Transcript-shaped input is rejected before durable storage.",
        );
        const submitted = await host.call("triage_report", { ...envelope, operationId: randomUUID() });
        const saved = identity(submitted);
        requireCheck(
            summary.checks,
            "planning-handoff",
            submitted.ok === true && saved.kind === "plan",
            "Core returns the Planner handoff through the installed Codex package.",
        );
        await world.snapshot("planned", "initial");
        await host.stop();
        host = world.protocolHost("restored");
        await host.initialize();
        const restored = await host.call("status", {});
        requireCheck(
            summary.checks,
            "fresh-process-restoration",
            JSON.stringify(identity(restored)) === JSON.stringify(saved),
            "A fresh host process restores the same workflow, revision, and action.",
        );
        await host.stop();
        world.plugin(["remove", "runwield@runwield"]);
        world.plugin(["add", "runwield@runwield"]);
        host = world.protocolHost("reinstalled");
        await host.initialize();
        const reinstalled = await host.call("status", {});
        requireCheck(
            summary.checks,
            "reinstallation-restoration",
            JSON.stringify(identity(reinstalled)) === JSON.stringify(saved),
            "Removing and reinstalling the plugin preserves Core workflow state.",
        );
        await host.stop();
        const evidence = await collectEvidence(world.root);
        const handshake = assessHandshake(evidence, summary.hostVersion ?? "");
        summary.checks.push(handshake);
        if (handshake.outcome !== "pass") throw new Error("Host identity did not match");
        const privacy = await world.privacy();
        requireCheck(
            summary.checks,
            "privacy",
            privacy.leaks.length === 0 && privacy.errors.length === 0,
            "Rejected transcript sentinels are absent from durable files and Git objects.",
        );
        summary.outcome = "pass";
    } catch (error) {
        summary.outcome = error instanceof PrerequisiteError ? "blocked" : "fail";
        summary.blockedPrerequisite = error instanceof PrerequisiteError ? error.prerequisite : null;
        summary.checks.push({
            id: "journey",
            outcome: "fail",
            detail:
                error instanceof PrerequisiteError
                    ? error.message
                    : "The installed protocol journey did not complete; retained fixture permits diagnosis.",
        });
    } finally {
        await world.close();
    }
    if (prepared) {
        try {
            requireCheck(
                summary.checks,
                "source-stability",
                await world.sourceUnchanged(),
                "Runtime source and package catalog remained unchanged during the run.",
            );
        } catch {
            summary.outcome = "fail";
        }
    }
    await writeFile(join(world.root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    if (summary.outcome === "pass" && !options.keep) await world.discardPrivateFiles();
    return summary;
}
