import { join } from "node:path";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HostedSession } from "../session/hosted-session.js";
import { createSessionRuntimeEvent } from "../session/session-runtime-events.js";
import {
    runValidationLoop as runValidationLoopImpl,
    runValidationPhase as runValidationPhaseImpl,
} from "./validation.ts";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
export async function git(cwd, args) {
    const output = await captureForegroundProcess("git", { cwd, args });
    const text = new TextDecoder().decode(output.stdout);
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return text.trim();
}

/**
 * @typedef {Object} ReviewSurfaceReady
 * @property {string} url
 * @property {boolean} opened
 */

/**
 * @typedef {Object} ReviewSurfaceReadyMeta
 * @property {(surface: ReviewSurfaceReady) => void} [onSurfaceReady]
 */

/**
 * @returns {any & { messages: string[], systemCalls: Array<{ message: string, isError: boolean, header: string, level: string, validationProgress?: import('../session/session-runtime-events.js').RuntimeValidationProgress }>, promptSelections: string[], busyStates: boolean[], toolCalls: Array<{ id: string, name: string, args: string }>, toolOutputs: string[], toolResults: Array<{ id: string, name: string, result: string, isError: boolean, durationMs: number }> }}
 */
export function makeUi() {
    /** @type {string[]} */
    const messages = [];
    /** @type {Array<{ message: string, isError: boolean, header: string, level: string, validationProgress?: import('../session/session-runtime-events.js').RuntimeValidationProgress }>} */
    const systemCalls = [];
    /** @type {string[]} */
    const promptSelections = [];
    /** @type {boolean[]} */
    const busyStates = [];
    /** @type {Array<{ id: string, name: string, args: string }>} */
    const toolCalls = [];
    /** @type {string[]} */
    const toolOutputs = [];
    /** @type {Array<{ id: string, name: string, result: string, isError: boolean, durationMs: number }>} */
    const toolResults = [];
    const recorder = /** @type {any} */ ({
        messages,
        systemCalls,
        promptSelections,
        busyStates,
        toolCalls,
        toolOutputs,
        toolResults,
        appendSystemMessage: (
            /** @type {string} */ msg,
            /** @type {boolean} */ isError = false,
            /** @type {string} */ header = "",
        ) => {
            messages.push(String(msg));
            systemCalls.push({ message: String(msg), isError, header, level: isError ? "error" : "info" });
        },
        promptSelect: () => {
            promptSelections.push("prompted");
            return Promise.resolve("stop");
        },
        promptText: () => Promise.resolve("deno task test"),
        setBusy: (/** @type {boolean} */ busy) => busyStates.push(busy),
        startToolExecution: (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ args) => {
            toolCalls.push({ id, name, args });
            return {
                setOutput: (/** @type {string} */ text) => toolOutputs.push(text),
                endExecution: (/** @type {boolean} */ isError, /** @type {number} */ durationMs) => {
                    toolResults.push({ id, name, result: "", isError, durationMs });
                },
                bodyText: "",
                startTime: Date.now(),
            };
        },
        addToolInvoked: (/** @type {{ id: string, name: string, input: { command?: string } }} */ event) => {
            toolCalls.push({ id: event.id, name: event.name, args: event.input.command || "" });
        },
        addToolResult: (
            /** @type {{ id: string, name: string, result: string, isError: boolean, durationMs: number }} */ event,
        ) => {
            toolResults.push(event);
        },
    });
    return recorder;
}

/**
 * @param {HostedSession} session
 * @param {ReturnType<typeof makeUi>} recorder
 * @returns {HostedSession}
 */
export function attachRecorder(session, recorder) {
    session.setEventSink((/** @type {any} */ partialEvent) => {
        const event = /** @type {any} */ (createSessionRuntimeEvent(session.id, partialEvent));
        if (event.type === "system_status" || event.type === "terminal_error") {
            const message = String(event.message || "");
            recorder.messages.push(message);
            recorder.systemCalls.push({
                message,
                isError: event.level === "error" || event.type === "terminal_error",
                header: event.header || "",
                level: event.level || (event.type === "terminal_error" ? "error" : "info"),
                ...(event.validationProgress ? { validationProgress: event.validationProgress } : {}),
            });
        } else if (event.type === "busy_changed") {
            recorder.busyStates.push(Boolean(event.busy));
        } else if (event.type === "tool_start") {
            recorder.toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.args?.command || "" });
        } else if (event.type === "tool_update") {
            recorder.toolOutputs.push(event.output);
        } else if (event.type === "tool_end") {
            recorder.toolOutputs.push(event.output);
            recorder.toolResults.push({
                id: event.toolCallId,
                name: event.toolName,
                result: event.output,
                isError: Boolean(event.isError),
                durationMs: Number(event.durationMs || 0),
            });
        }
    });
    session.setInteractionAdapter({
        requestInteraction: async (request) => {
            if (request.type === "text") {
                const value = await recorder.promptText(request.prompt, request);
                return value === null ? { outcome: "canceled" } : { outcome: "text", value };
            }
            if (request.type === "code_review") {
                const meta = /** @type {ReviewSurfaceReadyMeta} */ (request._meta || {});
                meta.onSurfaceReady?.({ url: "http://127.0.0.1/review/code?token=test", opened: true });
            }
            const value = await recorder.promptSelect(request.prompt, request.options || []);
            return value === null ? { outcome: "canceled" } : { outcome: "selected", value };
        },
    });
    return session;
}

/**
 * @param {string} id
 * @param {ReturnType<typeof makeUi>} recorder
 * @returns {HostedSession}
 */
export function makeRecordedSession(id, recorder) {
    return attachRecorder(new HostedSession({ id, cwd: getCwd() }), recorder);
}

export function noOpRecordPlanEvent() {
    return Promise.resolve({});
}

/**
 * External model boundary for validation scenarios that must never start an
 * isolated Agent. Keeping the failure loud ensures a fixture cannot silently
 * call a real LLM when a phase boundary changes.
 */
export const NO_ISOLATED_AGENT_PORT = Object.freeze({
    runIsolatedAgentSession: () => Promise.reject(new Error("Unexpected isolated Agent session in validation test")),
});

/**
 * A real project root for a validation test.
 *
 * Workflow Validation settles its outcomes through the actual transaction layer,
 * which takes Plan locks and writes recovery journals under `.wld/`. That needs a
 * writable directory holding a real Plan — a placeholder path like `/primary`
 * fails, and the repository's own root would let tests write into the developer's
 * checkout and interfere with each other.
 *
 * One root per test keeps them independent: a journal a failure path leaves behind
 * blocks later work on that Plan, which is the intended behavior and must not leak
 * into the next test.
 *
 * @param {string} [planName]
 * @param {Record<string, unknown>} [attrs]
 * @returns {Promise<string>}
 */
export async function makeValidationProjectRoot(planName = "p", attrs = {}) {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-validation-root-"));
    const { savePlan } = await import("../../plan-store.js");
    await savePlan(root, planName, `# ${planName}\n\nvalidation fixture\n`, {
        classification: "FEATURE",
        status: "in_progress",
        summary: "validation fixture",
        affectedPaths: [],
        ...attrs,
    });
    return root;
}

/**
 * A stub Git boundary for tests that do not run a real repository.
 *
 * Git is a genuine external boundary, so faking it is legitimate — but it has to be
 * asked for. These answers used to be handed out implicitly: `getBranchHead` and
 * `isCommitAncestorOfBranch` were replaced with constants whenever a test injected
 * `mergeExecutionWorktree`, so a test faking a merge also got an ancestry check that
 * always said yes, without requesting either. Tests that exercise real publication
 * must pass no port at all and use a real repository instead.
 *
 * @param {Partial<import('../git-port.ts').GitPort>} [overrides]
 * @returns {import('../git-port.ts').GitPort}
 */
export function makeStubGitPort(overrides = {}) {
    return {
        branchHead: () => Promise.resolve("b".repeat(40)),
        isAncestor: () => Promise.resolve(true),
        captureTree: () => Promise.resolve("stub-tree"),
        diffTrees: () => Promise.resolve(""),
        diffAgainstTree: () => Promise.resolve(""),
        ...overrides,
    };
}

/**
 * Required external boundaries for validation tests that do not exercise them.
 *
 * Git is a stable, stateless fake because it is an external subprocess boundary.
 * CI fails loudly so a phase change cannot accidentally run a nested real test suite.
 */
export const UNEXPECTED_VALIDATION_PORTS = Object.freeze({
    git: makeStubGitPort(),
    localCI: Object.freeze({
        run: () => Promise.reject(new Error("Unexpected Local CI run in validation test")),
    }),
    workRecordMnemotecaPort: Object.freeze({
        run: () => Promise.reject(new Error("Unexpected Mnemoteca run in validation test")),
    }),
});

/**
 * @typedef {Omit<Parameters<typeof runValidationLoopImpl>[0], "git" | "localCI" | "workRecordMnemotecaPort"> & Partial<Pick<Parameters<typeof runValidationLoopImpl>[0], "git" | "localCI" | "workRecordMnemotecaPort">>} ValidationTestArgs
 */

/** Run the public loop with explicit external-boundary fixtures. @param {ValidationTestArgs} args */
export function runValidationLoop(args) {
    return runValidationLoopImpl({ ...UNEXPECTED_VALIDATION_PORTS, ...args });
}

/** Run one public phase with explicit external-boundary fixtures. @param {ValidationTestArgs} args */
export function runValidationPhase(args) {
    return runValidationPhaseImpl({ ...UNEXPECTED_VALIDATION_PORTS, ...args });
}

/**
 * Publication-proof stand-ins for tests whose worktree is not a real repository.
 *
 * `checkpointExecutionWorktree` and `assertPreMergeCandidateUnchanged` are
 * RunWield's own proof policy, not Git, so they are on the machinery denylist and are
 * meant to lose their seams as tests move to real worktrees. Until then they must at
 * least be requested out loud: they used to be swapped for these same no-ops purely
 * because a test injected `mergeExecutionWorktree`, which is how a suite ends up
 * exercising a path that exists only under fakes.
 *
 * @returns {Record<string, unknown>}
 */
export function noOpPublicationProofDeps() {
    return {
        checkpointExecutionWorktree: () => Promise.resolve({ executionCommit: "a".repeat(40) }),
        assertPreMergeCandidateUnchanged: () => Promise.resolve(),
    };
}
