/**
 * @module ui/tui/testing/scripted-review-surface
 * Protocol-checked Plan Review and Runtime interaction fixtures.
 */

import { getCwd } from "../../../constants.js";

/**
 * @typedef {Object} ScriptedReviewDecision
 * @property {boolean} approved
 * @property {string} [feedback]
 * @property {boolean} [canceled]
 * @property {string} [approvalAction]
 * @property {"engineer"|"frontend-engineer"} [executionAgent]
 * @property {"autonomous"|"pair"} [collaborationRecommendation]
 * @property {unknown} [plan]
 */

/**
 * @typedef {Object} ScriptedHumanReviewDecision
 * @property {boolean} [manual] Leave the real browser review unanswered for terminal-driven cancellation.
 * @property {boolean} [approved]
 * @property {string} [feedback]
 * @property {boolean} [canceled]
 * @property {boolean} [exit]
 * @property {Array<{ file?: string, path?: string, filePath?: string, line?: number, text?: string, comment?: string }>} [annotations]
 * @property {Array<{ path: string, name: string }>} [images]
 *
 * @typedef {Object} ScriptedRuntimeInteraction
 * @property {"select"|"text"|"approval"} type
 * @property {string} [promptIncludes]
 * @property {string|null} [value]
 * @property {{ path: string, text: string, target?: "project"|"execution"|"repair", planName?: string, commands?: string[] }} [userFixesFirst] what the user does in the
 * project before answering. RunWield pauses precisely when it needs a person to change
 * something, so a scenario that cannot model the person changing it can only ever test
 * giving up — never the Retry that follows.
 */

export class ScriptedReviewSurface {
    /** @param {ScriptedReviewDecision[]} decisions */
    constructor(decisions) {
        /** @type {ScriptedReviewDecision[]} */
        this.decisions = decisions.map((decision) => ({ ...decision }));
        /** @type {Array<{ request: Record<string, unknown>, decision: ScriptedReviewDecision }>} */
        this.consumed = [];
    }

    /** @param {Record<string, unknown>} request */
    submit(request) {
        if (!this.decisions.length) {
            throw new Error("Unexpected Plan Review interaction: no scripted decisions remain.");
        }
        const decision = this.decisions.shift();
        if (!decision) throw new Error("Unexpected Plan Review interaction: no scripted decisions remain.");
        this.consumed.push({ request, decision });
        const approved = Boolean(decision.approved);
        return {
            approved,
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
    /** @param {ScriptedHumanReviewDecision[]} decisions */
    constructor(decisions) {
        /** @type {ScriptedHumanReviewDecision[]} */
        this.decisions = decisions.map((decision) => ({ ...decision }));
        /** @type {Array<{ request: Record<string, unknown>, decision: ScriptedHumanReviewDecision }>} */
        this.consumed = [];
    }

    /** @param {Record<string, unknown>} request */
    submit(request) {
        if (!this.decisions.length) {
            throw new Error("Unexpected Code Review interaction: no scripted decisions remain.");
        }
        const decision = this.decisions.shift();
        if (!decision) throw new Error("Unexpected Code Review interaction: no scripted decisions remain.");
        this.consumed.push({ request, decision });
        return {
            manual: decision.manual === true,
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
    /**
     * @param {ScriptedRuntimeInteraction[]} interactions
     * @param {(planName?: string) => string} [resolveExecutionCwd]
     */
    constructor(interactions, resolveExecutionCwd = () => getCwd()) {
        /** @type {ScriptedRuntimeInteraction[]} */
        this.interactions = interactions.map((interaction) => ({ ...interaction }));
        /** @type {Array<{ request: Record<string, unknown>, interaction: ScriptedRuntimeInteraction, userFixCwd?: string, userFixPath?: string }>} */
        this.consumed = [];
        this.resolveExecutionCwd = resolveExecutionCwd;
    }

    /**
     * @param {"select"|"text"|"approval"} type
     * @param {Record<string, unknown>} request
     */
    next(type, request) {
        if (!this.interactions.length) throw new Error(`Unexpected Runtime interaction: ${type}`);
        const interaction = this.interactions.shift();
        if (!interaction) throw new Error(`Unexpected Runtime interaction: ${type}`);
        if (interaction.type !== type) {
            throw new Error(`Unexpected Runtime interaction: expected ${interaction.type}, got ${type}`);
        }
        if (interaction.promptIncludes && !String(request.prompt || "").includes(interaction.promptIncludes)) {
            throw new Error(
                `Unexpected Runtime interaction prompt for ${type}: expected ${
                    JSON.stringify(interaction.promptIncludes)
                }, got ${JSON.stringify(String(request.prompt || ""))}`,
            );
        }
        /** @type {{ request: Record<string, unknown>, interaction: ScriptedRuntimeInteraction, userFixCwd?: string, userFixPath?: string }} */
        const consumed = { request, interaction };
        this.consumed.push(consumed);
        if (interaction.userFixesFirst) {
            const repairMatch = String(request.prompt || "").match(/Open ([^,\n]+), fix the files/);
            const cwd = interaction.userFixesFirst.target === "execution"
                ? this.resolveExecutionCwd(interaction.userFixesFirst.planName)
                : interaction.userFixesFirst.target === "repair"
                ? repairMatch?.[1]
                : getCwd();
            if (!cwd) throw new Error("The interaction did not name a publication repair checkout.");
            const target = `${cwd}/${interaction.userFixesFirst.path}`;
            Deno.writeTextFileSync(target, interaction.userFixesFirst.text);
            consumed.userFixCwd = cwd;
            consumed.userFixPath = target;
            for (const command of interaction.userFixesFirst.commands || []) {
                const output = new Deno.Command("bash", {
                    cwd,
                    args: ["-lc", command],
                    stdout: "piped",
                    stderr: "piped",
                }).outputSync();
                if (!output.success) {
                    throw new Error(new TextDecoder().decode(output.stderr) || `User fix command failed: ${command}`);
                }
            }
        }
        return interaction.value ?? null;
    }

    assertComplete() {
        if (this.interactions.length) {
            throw new Error(`Unused scripted Runtime interactions: ${this.interactions.length}`);
        }
    }
}
