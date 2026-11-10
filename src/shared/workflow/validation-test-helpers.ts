import { join } from "node:path";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.ts";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PlanFrontMatterInput } from "../../plan-store.js";
import type { runCodeReview } from "../../ui/review/code-review.ts";
import type { UiAPI } from "../../ui/tui/api.ts";
import type { GitPort } from "../git-port.ts";
import type { SessionRuntimeEventSink } from "../session/session-host.ts";
import type { RuntimeToolTitleArgs } from "../session/tool-event-title.ts";
import { HostedSession } from "../session/hosted-session.js";
import { createSessionRuntimeEvent, type RuntimeSystemStatusEvent } from "../session/session-runtime-events.js";
import {
    runValidationLoop as runValidationLoopImpl,
    runValidationPhase as runValidationPhaseImpl,
    type ValidationLoopArgs,
} from "./validation.ts";

export async function git(cwd: string, args: string[]) {
    const output = await captureForegroundProcess("git", { cwd, args });
    const text = new TextDecoder().decode(output.stdout);
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return text.trim();
}

type ReviewSurfaceReadyMeta = Pick<Parameters<typeof runCodeReview>[0], "onSurfaceReady">;
type StatusEventFields = Pick<RuntimeSystemStatusEvent, "header" | "level" | "validationProgress">;
type RecordedStatusEvent = Pick<RuntimeSystemStatusEvent, "message"> & Partial<StatusEventFields>;
type CommandInput = Pick<RuntimeToolTitleArgs, "command">;

interface RecordedSystemCall extends Pick<RecordedStatusEvent, "message" | "validationProgress"> {
    isError: boolean;
    header: string;
    level: StatusEventFields["level"];
}

interface RecordedToolCall {
    id: string;
    name: string;
    args: string;
}

interface RecordedToolResult extends Pick<RecordedToolCall, "id" | "name"> {
    result: string;
    isError: boolean;
    durationMs: number | null;
}

interface ToolInvocation extends Pick<RecordedToolCall, "id" | "name"> {
    input: CommandInput;
}

export function makeUi() {
    const messages: string[] = [];
    const systemCalls: RecordedSystemCall[] = [];
    const promptSelections: string[] = [];
    const busyStates: boolean[] = [];
    const toolCalls: RecordedToolCall[] = [];
    const toolOutputs: string[] = [];
    const toolResults: RecordedToolResult[] = [];
    const promptSelect: UiAPI["promptSelect"] = () => {
        promptSelections.push("prompted");
        return Promise.resolve("stop");
    };
    const promptText: UiAPI["promptText"] = () => Promise.resolve("deno task test");
    const recorder = {
        messages,
        systemCalls,
        promptSelections,
        busyStates,
        toolCalls,
        toolOutputs,
        toolResults,
        appendSystemMessage: (msg: string, isError = false, header = "") => {
            messages.push(String(msg));
            systemCalls.push({ message: String(msg), isError, header, level: isError ? "error" : "info" });
        },
        promptSelect,
        promptText,
        setBusy: (busy: boolean) => busyStates.push(busy),
        startToolExecution: (id: string, name: string, args: string) => {
            toolCalls.push({ id, name, args });
            return {
                setOutput: (text: string) => toolOutputs.push(text),
                endExecution: (isError: boolean, durationMs: number | null) => {
                    toolResults.push({ id, name, result: "", isError, durationMs });
                },
                bodyText: "",
                startTime: Date.now(),
            };
        },
        addToolInvoked: (event: ToolInvocation) => {
            toolCalls.push({ id: event.id, name: event.name, args: event.input.command || "" });
        },
        addToolResult: (event: RecordedToolResult) => {
            toolResults.push(event);
        },
    };
    return recorder;
}

export type ValidationUiRecorder = ReturnType<typeof makeUi>;

export function attachRecorder(session: HostedSession, recorder: ValidationUiRecorder): HostedSession {
    session.setEventSink((partialEvent: Parameters<SessionRuntimeEventSink["emit"]>[0]) => {
        const event = createSessionRuntimeEvent(session.id, partialEvent);
        if (event.type === "system_status" || event.type === "terminal_error") {
            // Terminal errors can also carry optional status fields.
            const status: RecordedStatusEvent = event;
            const message = String(event.message || "");
            recorder.messages.push(message);
            recorder.systemCalls.push({
                message,
                isError: status.level === "error" || event.type === "terminal_error",
                header: status.header || "",
                level: status.level || (event.type === "terminal_error" ? "error" : "info"),
                ...(status.validationProgress ? { validationProgress: status.validationProgress } : {}),
            });
        } else if (event.type === "busy_changed") {
            recorder.busyStates.push(Boolean(event.busy));
        } else if (event.type === "tool_start") {
            recorder.toolCalls.push({
                id: event.toolCallId,
                name: event.toolName,
                args: (event.args as CommandInput | null | undefined)?.command || "",
            });
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
                const meta = (request._meta || {}) as ReviewSurfaceReadyMeta;
                meta.onSurfaceReady?.({ url: "http://127.0.0.1/review/code?token=test", opened: true });
            }
            const value = await recorder.promptSelect(request.prompt, request.options || []);
            return value === null ? { outcome: "canceled" } : { outcome: "selected", value };
        },
    });
    return session;
}

export function makeRecordedSession(id: string, recorder: ValidationUiRecorder): HostedSession {
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

 */
export async function makeValidationProjectRoot(planName = "p", attrs: PlanFrontMatterInput = {}) {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-validation-root-"));
    const { savePlan, ensurePlanIdentity } = await import("../../plan-store.js");
    await savePlan(root, planName, `# ${planName}\n\nvalidation fixture\n`, {
        classification: "FEATURE",
        status: "in_progress",
        summary: "validation fixture",
        affectedPaths: [],
        planId: crypto.randomUUID(),
        ...attrs,
    });
    await ensurePlanIdentity(root, planName);
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

 */
export function makeStubGitPort(overrides: Partial<GitPort> = {}): GitPort {
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

type FixturePortName = keyof typeof UNEXPECTED_VALIDATION_PORTS;

export type ValidationTestArgs = Omit<ValidationLoopArgs, FixturePortName> &
    Partial<Pick<ValidationLoopArgs, FixturePortName>>;

/** Run the public loop with explicit external-boundary fixtures. */
export function runValidationLoop(args: ValidationTestArgs) {
    return runValidationLoopImpl({ ...UNEXPECTED_VALIDATION_PORTS, ...args });
}

/** Run one public phase with explicit external-boundary fixtures. */
export function runValidationPhase(args: ValidationTestArgs) {
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

 */
export function noOpPublicationProofDeps() {
    return {
        checkpointExecutionWorktree: () => Promise.resolve({ executionCommit: "a".repeat(40) }),
        assertPreMergeCandidateUnchanged: () => Promise.resolve(),
    };
}
