/**
 * @module ui/tui/testing/scenario-actor
 * Protocol-checked deterministic model script dispatcher for Golden scenarios.
 */

import {
    fauxAssistantMessage,
    fauxText,
    fauxThinking,
    fauxToolCall,
    type AssistantMessage,
} from "@earendil-works/pi-ai";

export interface GoldenScriptToolCall {
    name: string;
    arguments: unknown;
    id?: string;
}

export interface GoldenScriptTurn {
    id: string;
    agent: string;
    phase?: string;
    ordinal?: number;
    planName?: string;
    availableTools?: string[];
    requiredTools?: string[];
    forbiddenTools?: string[];
    response?: unknown;
    text?: string;
    thinking?: string;
    toolCalls?: GoldenScriptToolCall[];
    optional?: boolean;
}

export interface GoldenTurnRequest {
    agent: string;
    phase?: string;
    ordinal?: number;
    /** Workflow Plan the Runtime reports as executing. */
    planName?: string;
    availableTools?: string[];
}

export type GoldenTurnResolver = (context: unknown, options: unknown) => GoldenTurnRequest;
type FauxToolArguments = Parameters<typeof fauxToolCall>[1];

function normalizeSet(value: string[] = []) {
    return new Set(value.map((item) => String(item)));
}

function turnMatches(turn: GoldenScriptTurn, request: GoldenTurnRequest) {
    if (turn.agent !== request.agent) return false;
    if (turn.phase && turn.phase !== request.phase) return false;
    // An Epic runs several child Plans through the same Agent and phase, so a turn
    // may pin the Plan it belongs to. Ordinals are counted per Plan, which keeps one
    // child's turn count from shifting the next child's script.
    if (turn.planName && turn.planName !== request.planName) return false;
    if (turn.ordinal !== undefined && turn.ordinal !== request.ordinal) return false;
    return true;
}

export function createFauxMessageForTurn(turn: GoldenScriptTurn): AssistantMessage {
    if (turn.response && typeof turn.response === "object") return turn.response as AssistantMessage;
    const blocks: AssistantMessage["content"] = [];
    if (turn.thinking) blocks.push(fauxThinking(turn.thinking));
    if (turn.text || typeof turn.response === "string") blocks.push(fauxText(turn.text || String(turn.response || "")));
    for (const toolCall of turn.toolCalls || []) {
        blocks.push(fauxToolCall(toolCall.name, toolCall.arguments as FauxToolArguments, { id: toolCall.id }));
    }
    return fauxAssistantMessage(blocks.length === 1 ? blocks[0] : blocks);
}

export class GoldenScenarioActor {
    declare remaining: GoldenScriptTurn[];
    declare consumed: GoldenScriptTurn[];

    constructor(script: GoldenScriptTurn[]) {
        this.remaining = script.map((turn) => ({ ...turn }));
        this.consumed = [];
    }

    next(request: GoldenTurnRequest) {
        const availableTools = normalizeSet(request.availableTools);
        let matches = this.remaining.filter((turn) => turnMatches(turn, request));
        if (matches.length > 1 && request.ordinal !== undefined) {
            const exactOrdinalMatches = matches.filter((turn) => turn.ordinal === request.ordinal);
            if (exactOrdinalMatches.length === 1) matches = exactOrdinalMatches;
        }
        if (matches.length > 1) {
            const toolFiltered = matches.filter((turn) => {
                const requiredTools = new Set([
                    ...(turn.requiredTools || []),
                    ...(turn.toolCalls || []).map((toolCall) => toolCall.name),
                ]);
                return [...requiredTools].every((tool) => availableTools.has(tool));
            });
            if (toolFiltered.length === 1) matches = toolFiltered;
        }
        if (matches.length === 0) {
            throw new Error(
                `Unexpected scripted turn for agent=${request.agent} phase=${request.phase || ""}; remaining=${this.remaining
                    .map((turn) => turn.id)
                    .join(",")}`,
            );
        }
        if (matches.length > 1) {
            throw new Error(
                `Ambiguous scripted turn for agent=${request.agent} phase=${request.phase || ""}; matches=${matches
                    .map((turn) => turn.id)
                    .join(",")}`,
            );
        }
        const turn = matches[0];
        if (turn.availableTools) {
            const expectedTools = normalizeSet(turn.availableTools);
            const missing = [...expectedTools].filter((tool) => !availableTools.has(tool));
            const unexpected = [...availableTools].filter((tool) => !expectedTools.has(tool));
            if (missing.length || unexpected.length) {
                throw new Error(
                    `Available tool set mismatch for ${turn.id}: missing=${missing.join(",") || "none"} unexpected=${
                        unexpected.join(",") || "none"
                    }`,
                );
            }
        }
        const requiredTools = new Set([
            ...(turn.requiredTools || []),
            ...(turn.toolCalls || []).map((toolCall) => toolCall.name),
        ]);
        for (const tool of requiredTools) {
            if (!availableTools.has(tool)) {
                throw new Error(
                    `Required tool unavailable for ${turn.id}: ${tool}; available: ${
                        [...availableTools].sort().join(",") || "none"
                    }`,
                );
            }
        }
        for (const tool of turn.forbiddenTools || []) {
            if (availableTools.has(tool)) throw new Error(`Forbidden tool available for ${turn.id}: ${tool}`);
        }
        this.remaining = this.remaining.filter((candidate) => candidate !== turn);
        this.consumed.push(turn);
        return turn.response;
    }

    /**
     * Return a faux-provider response factory that dispatches through the same
     * protocol checks as direct actor use. The caller supplies actual Agent and
     * phase identity from Runtime/Agent context rather than prompt text.
     */
    toFauxResponseFactory(resolveTurn: GoldenTurnResolver) {
        return (context: unknown, options: unknown) => {
            this.next(resolveTurn(context, options));
            const turn = this.consumed.at(-1);
            if (!turn) throw new Error("Faux response factory did not consume a scripted turn.");
            return createFauxMessageForTurn(turn);
        };
    }

    assertComplete() {
        const remainingRequired = this.remaining.filter((turn) => !turn.optional);
        if (remainingRequired.length) {
            throw new Error(`Unused scripted turns: ${remainingRequired.map((turn) => turn.id).join(",")}`);
        }
    }

    diagnostics() {
        return {
            consumed: this.consumed.map((turn) => turn.id),
            remaining: this.remaining.filter((turn) => !turn.optional).map((turn) => turn.id),
        };
    }
}
