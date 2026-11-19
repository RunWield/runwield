import { spawnSync } from "node:child_process";
import { writeFileSync as fsWriteFileSync } from "node:fs";
/**
 * @module ui/tui/testing/scripted-review-surface
 * Protocol-checked Plan Review and Runtime interaction fixtures.
 */

import { getCwd } from "../../../constants.ts";

export interface ScriptedReviewDecision {
    approved: boolean;
    conversationTurn?: boolean;
    feedback?: string;
    canceled?: boolean;
    approvalAction?: string;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
    /** Opaque Plan payload supplied by the JavaScript scenario runner. */
    plan?: unknown;
}

export interface ScriptedReviewAnnotation {
    file?: string;
    path?: string;
    filePath?: string;
    line?: number;
    text?: string;
    comment?: string;
}

export interface ScriptedReviewImage {
    path: string;
    name: string;
}

export interface ScriptedHumanReviewDecision {
    /** Leave the real browser review unanswered for terminal-driven cancellation. */
    manual?: boolean;
    conversationTurn?: boolean;
    approved?: boolean;
    feedback?: string;
    canceled?: boolean;
    exit?: boolean;
    annotations?: ScriptedReviewAnnotation[];
    images?: ScriptedReviewImage[];
}

export interface ScriptedUserFix {
    path: string;
    text: string;
    target?: "project" | "execution" | "repair";
    planName?: string;
    commands?: string[];
}

export interface ScriptedRuntimeInteraction {
    type: "select" | "text" | "approval";
    promptIncludes?: string;
    value?: string | null;
    /** The prompt may be absent when asynchronous work finished before reload. */
    optional?: boolean;
    /**
     * What the user does in the project before answering. RunWield pauses precisely when
     * it needs a person to change something, so a scenario that cannot model the person
     * changing it can only ever test giving up — never the Retry that follows.
     */
    userFixesFirst?: ScriptedUserFix;
}

/** Requests cross the JavaScript scenario-runner boundary without validation. */
export interface ScriptedSurfaceRequest {
    [key: string]: unknown;
    prompt?: unknown;
}

export interface ConsumedScriptedReview {
    request: ScriptedSurfaceRequest;
    decision: ScriptedReviewDecision;
}

export interface ConsumedScriptedHumanReview {
    request: ScriptedSurfaceRequest;
    decision: ScriptedHumanReviewDecision;
}

export interface ConsumedScriptedInteraction {
    request: ScriptedSurfaceRequest;
    interaction: ScriptedRuntimeInteraction;
    userFixCwd?: string;
    userFixPath?: string;
}

export type ResolveExecutionCwd = (planName?: string) => string;

export class ScriptedReviewSurface {
    declare decisions: ScriptedReviewDecision[];
    declare consumed: ConsumedScriptedReview[];

    constructor(decisions: ScriptedReviewDecision[]) {
        this.decisions = decisions.map((decision) => ({ ...decision }));
        this.consumed = [];
    }

    submit(request: ScriptedSurfaceRequest) {
        if (!this.decisions.length) {
            throw new Error("Unexpected Plan Review interaction: no scripted decisions remain.");
        }
        const decision = this.decisions.shift();
        if (!decision) throw new Error("Unexpected Plan Review interaction: no scripted decisions remain.");
        this.consumed.push({ request, decision });
        const approved = Boolean(decision.approved);
        return {
            approved,
            conversationTurn: decision.conversationTurn === true,
            canceled: Boolean(decision.canceled),
            feedback: decision.feedback || "",
            approvalAction: decision.approvalAction || (approved ? "later" : undefined),
            executionAgent: decision.executionAgent,
            collaborationRecommendation: decision.collaborationRecommendation,
            plan: decision.plan,
        };
    }

    assertComplete() {
        if (this.decisions.length) throw new Error(`Unused scripted review decisions: ${this.decisions.length}`);
    }
}

export class ScriptedHumanReviewSurface {
    declare decisions: ScriptedHumanReviewDecision[];
    declare consumed: ConsumedScriptedHumanReview[];

    constructor(decisions: ScriptedHumanReviewDecision[]) {
        this.decisions = decisions.map((decision) => ({ ...decision }));
        this.consumed = [];
    }

    submit(request: ScriptedSurfaceRequest) {
        if (!this.decisions.length) {
            throw new Error("Unexpected Code Review interaction: no scripted decisions remain.");
        }
        const decision = this.decisions.shift();
        if (!decision) throw new Error("Unexpected Code Review interaction: no scripted decisions remain.");
        this.consumed.push({ request, decision });
        return {
            manual: decision.manual === true,
            conversationTurn: decision.conversationTurn === true,
            approved: decision.approved === true,
            feedback: decision.feedback || "",
            canceled: decision.canceled === true,
            exit: decision.exit === true,
            annotations: decision.annotations || [],
            images: decision.images || [],
            reviewType: "code",
        };
    }

    assertComplete() {
        if (this.decisions.length) throw new Error(`Unused scripted human review decisions: ${this.decisions.length}`);
    }
}

export class ScriptedInteractionSurface {
    declare interactions: ScriptedRuntimeInteraction[];
    declare consumed: ConsumedScriptedInteraction[];
    declare resolveExecutionCwd: ResolveExecutionCwd;

    constructor(interactions: ScriptedRuntimeInteraction[], resolveExecutionCwd: ResolveExecutionCwd = () => getCwd()) {
        this.interactions = interactions.map((interaction) => ({ ...interaction }));
        this.consumed = [];
        this.resolveExecutionCwd = resolveExecutionCwd;
    }

    next(type: ScriptedRuntimeInteraction["type"], request: ScriptedSurfaceRequest) {
        if (!this.interactions.length) throw new Error(`Unexpected Runtime interaction: ${type}`);
        const interaction = this.interactions.shift();
        if (!interaction) throw new Error(`Unexpected Runtime interaction: ${type}`);
        if (interaction.type !== type) {
            throw new Error(`Unexpected Runtime interaction: expected ${interaction.type}, got ${type}`);
        }
        if (interaction.promptIncludes && !String(request.prompt || "").includes(interaction.promptIncludes)) {
            throw new Error(
                `Unexpected Runtime interaction prompt for ${type}: expected ${JSON.stringify(
                    interaction.promptIncludes,
                )}, got ${JSON.stringify(String(request.prompt || ""))}`,
            );
        }
        const consumed: ConsumedScriptedInteraction = { request, interaction };
        this.consumed.push(consumed);
        if (interaction.userFixesFirst) {
            const repairMatch = String(request.prompt || "").match(/Open ([^,\n]+), fix the files/);
            const cwd =
                interaction.userFixesFirst.target === "execution"
                    ? this.resolveExecutionCwd(interaction.userFixesFirst.planName)
                    : interaction.userFixesFirst.target === "repair"
                      ? repairMatch?.[1]
                      : getCwd();
            if (!cwd) throw new Error("The interaction did not name a publication repair checkout.");
            const target = `${cwd}/${interaction.userFixesFirst.path}`;
            fsWriteFileSync(target, interaction.userFixesFirst.text);
            consumed.userFixCwd = cwd;
            consumed.userFixPath = target;
            for (const command of interaction.userFixesFirst.commands || []) {
                const output = spawnSync("bash", ["-lc", command], { cwd, stdio: "pipe" });
                if (output.error) throw output.error;
                if (output.status !== 0) {
                    throw new Error(new TextDecoder().decode(output.stderr) || `User fix command failed: ${command}`);
                }
            }
        }
        return interaction.value ?? null;
    }

    assertComplete() {
        const required = this.interactions.filter((interaction) => !interaction.optional);
        if (required.length) {
            throw new Error(`Unused scripted Runtime interactions: ${required.length}`);
        }
    }
}
