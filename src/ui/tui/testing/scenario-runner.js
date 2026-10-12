/**
 * @module ui/tui/testing/scenario-runner
 * Golden TUI scenario action runner and diagnostics helpers.
 */

import { dirname, join, relative } from "@std/path";
import { createSessionRuntime } from "../../../shared/session/session-runtime.ts";
import { RuntimeEventTypes } from "../../../shared/session/session-runtime-events.js";
import { openFileSessionStore } from "../../../shared/session/file-session-store.ts";
import { assert } from "@std/assert";
import { extractYaml } from "@std/front-matter";
import { PLAN_RUNTIME_FIELDS } from "../../../shared/workflow/controller-state.ts";
import { readControllerRecord } from "../../../shared/workflow/controller-registry.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { findPlansByParent, loadPlan, parsePlanFrontMatter } from "../../../plan-store.js";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { submitPlanForReview } from "../../review/plan-review.ts";
import { createScriptedReviewBrowser } from "../../review/review-test-fixture.ts";
import { createFauxMessageForTurn, GoldenScenarioActor } from "./scenario-actor.js";
import {
    createGoldenIsolatedEnvironment,
    GOLDEN_FAUX_API,
    GOLDEN_FAUX_MODEL,
    GOLDEN_FAUX_PROVIDER,
    writeGoldenModelConfig,
} from "./isolated-environment.js";
import {
    ScriptedHumanReviewSurface,
    ScriptedInteractionSurface,
    ScriptedReviewSurface,
} from "./scripted-review-surface.js";
import { normalizeScreenText, VirtualTerminal } from "./virtual-terminal.js";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import { getCwd } from "../../../constants.js";
import { getWorktreeRegistryPath } from "../../../shared/worktree-registry.js";
import { enterProjectRuntime } from "../../../shared/project-runtime-layout.ts";
import { isCurrentProjectRuntimePath } from "../../../shared/runwield-owned-paths.ts";
import { PLAN_STATUSES } from "../../../shared/workflow/plan-lifecycle.js";

/**
 * Scenario waits poll and return the moment the condition holds, so this budget
 * only bounds failures. Keep it generous: a tight bound buys nothing on the
 * success path and turns a loaded CI runner into a flake.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

/** @param {unknown} plan */
function planReviewClassification(plan) {
    if (typeof plan !== "string") return null;
    try {
        const classification = parsePlanFrontMatter(plan).attrs.classification;
        return classification === "FEATURE" ? "PLANNED_CHANGE" : classification || null;
    } catch {
        return null;
    }
}

/**
 * Keep the browser external while driving the real review launcher, server,
 * token check, and decision transport.
 *
 * @param {ScriptedReviewSurface | null} reviewSurface
 * @param {ScriptedHumanReviewSurface | null} humanReviewSurface
 * @param {Record<string, unknown>} request
 * @param {unknown} reviewedPlan
 * @param {(response: ReturnType<ScriptedReviewSurface['submit']>) => void} [onDecision]
 * @param {(response: ReturnType<ScriptedHumanReviewSurface['submit']>) => void} [onHumanReviewDecision]
 */
function createGoldenReviewBrowser(
    reviewSurface,
    humanReviewSurface,
    request,
    reviewedPlan,
    onDecision,
    onHumanReviewDecision,
) {
    return {
        /** @param {string} url */
        async open(url) {
            if (url.includes("/review/code")) {
                if (!humanReviewSurface) throw new Error("Unexpected Code Review interaction.");
                const response = humanReviewSurface.submit({ url });
                if (response.manual) return false;
                const opened = await createScriptedReviewBrowser(response.approved ? "decision" : "feedback", {
                    approved: response.approved,
                    feedback: response.feedback,
                    annotations: response.annotations,
                    images: response.images,
                    reviewType: "code",
                }).browser.open(url);
                onHumanReviewDecision?.(response);
                return opened;
            }
            if (!reviewSurface) throw new Error("Unexpected Plan Review interaction.");
            const response = reviewSurface.submit(request);
            const editedPlan = typeof reviewedPlan === "string"
                ? reviewedPlan
                : typeof response.plan === "string"
                ? response.plan
                : undefined;
            /** @type {"run" | "decompose" | "later" | undefined} */
            const approvalAction = response.approvalAction === "run" || response.approvalAction === "decompose" ||
                    response.approvalAction === "later"
                ? response.approvalAction
                : undefined;
            const classification = planReviewClassification(editedPlan);
            const includeExecutionPolicy = response.approved && approvalAction === "run" &&
                classification !== "PROJECT";
            const executionAgent = response.executionAgent || (includeExecutionPolicy ? "engineer" : undefined);
            const collaborationRecommendation = response.collaborationRecommendation ||
                (includeExecutionPolicy ? "autonomous" : undefined);
            const body = {
                approved: response.approved,
                feedback: response.feedback,
                approvalAction,
                ...(executionAgent ? { executionAgent } : {}),
                ...(collaborationRecommendation ? { collaborationRecommendation } : {}),
                ...(editedPlan ? { plan: editedPlan } : {}),
            };
            const opened = await createScriptedReviewBrowser(response.approved ? "decision" : "deny", body).browser
                .open(url);
            onDecision?.(response);
            return opened;
        },
    };
}

/**
 * Read the lifecycle state synchronously from isolated fixture Plans at the
 * interaction-resolved boundary, before the workflow can advance it again.
 *
 * @param {string} directory
 * @param {string} expectedStatus
 * @returns {{ status?: unknown, updatedAt?: unknown }}
 */
function findFixturePlanLifecycle(directory, expectedStatus) {
    try {
        for (const entry of Deno.readDirSync(directory)) {
            const path = join(directory, entry.name);
            if (entry.isDirectory) {
                const nested = findFixturePlanLifecycle(path, expectedStatus);
                if (nested.status === expectedStatus) return nested;
            } else if (entry.isFile && entry.name.endsWith(".md")) {
                const attrs = parsePlanFrontMatter(Deno.readTextFileSync(path)).attrs;
                if (attrs.status === expectedStatus) return { status: attrs.status, updatedAt: attrs.updatedAt };
            }
        }
    } catch {
        // A missing fixture directory is represented as no observed lifecycle.
    }
    return {};
}

/**
 * @typedef {Object} GoldenScenario
 * @property {string} name
 * @property {{ columns?: number, rows?: number }} [terminal]
 * @property {Array<Object>} [actions]
 * @property {Array<import('./scenario-actor.js').GoldenScriptTurn>} [script]
 * @property {Array<{ interactionType: string, decision?: string }>} [interactions]
 * @property {Array<import('./scripted-review-surface.js').ScriptedRuntimeInteraction>} [scriptedInteractions]
 * @property {string[]} [interactiveSelectPrompts] Prompt fragments driven by real terminal input even with other scripted interactions.
 * @property {Array<import('./scripted-review-surface.js').ScriptedReviewDecision>} [reviewDecisions]
 * @property {Array<import('./scripted-review-surface.js').ScriptedHumanReviewDecision>} [humanReviewDecisions]
 * @property {"new" | "continue"} [sessionStartMode]
 * @property {string} [initialAgentName]
 * @property {unknown} [reviewedPlan]
 * @property {Array<{ path: string, text: string }>} [initialProjectFiles]
 * @property {Array<{ path: string, text: string }>} [committedProjectFiles]
 * @property {boolean} [nonGitProject]
 * @property {Array<((result: GoldenScenarioResult) => void | Promise<void>) & { goldenCoverage?: string[] }>} [assertions]
 * @property {string[]} [coverage]
 * @property {number} [timeoutMs]
 * @property {number} [modelTokensPerSecond] external streaming latency; defaults to unlimited
 * @property {boolean} [composedTui]
 * @property {{ userText: string, agentName?: string, assistantText: string, model?: string, provider?: string, planName?: string, classification?: string, complexity?: string, interrupted?: boolean }} [priorSession]
 * @property {boolean} [corruptSession]
 * @property {"default" | "none" | "provider-without-models"} [modelSetup]
 * @property {Array<{ id: string, name?: string, reasoning?: boolean }>} [models]
 * @property {Record<string, unknown>} [globalSettings]
 * @property {boolean} [onboardingOfferHandled]
 * @property {boolean} [skipModelWelcome]
 * @property {boolean} [captureModelTurns]
 * @property {boolean} [captureGlobalSettings]
 * @property {boolean} [captureSystemMessages]
 * @property {Array<{ marker: string, keys?: string, text?: string }>} [startupInput]
 * @property {boolean} [expectedCleanExit]
 */

/**
 * @typedef {Object} GoldenScenarioResult
 * @property {string} name
 * @property {Record<string, unknown>} state
 * @property {string[]} events
 * @property {string} screenText
 * @property {string} [scrollbackText]
 * @property {ReturnType<GoldenScenarioActor['diagnostics']>} actor
 * @property {string | null} artifactDir
 */

/**
 * @typedef {Object} ProjectSnapshotEntry
 * @property {"file"|"dir"} kind
 * @property {string} [hash]
 */

/**
 * Evidence a composed scenario accumulates for its golden snapshot.
 *
 * The fields below are read back during the run, so they are typed. The rest are
 * written once by whichever scenario action produced them and then serialized —
 * which is what `GoldenScenarioResult.state` already declares as an opaque record,
 * and what the golden files, not the type system, assert.
 *
 * @typedef {Record<string, unknown> & {
 *     canceled: boolean,
 *     editorUsable: boolean,
 *     cleanupSucceeded: boolean,
 *     priorSession: Awaited<ReturnType<typeof seedGoldenPriorSession>> | null,
 *     turnSequence: string[],
 *     screen?: string,
 *     activeAgent?: string,
 *     publicationBaseline?: PublicationBaseline,
 *     validationCiRuns?: Array<{ output: string, isError: boolean }>,
 *     systemMessages?: Array<{ text: string, isError: boolean, header?: string }>,
 * }} ComposedScenarioState
 */

/**
 * @typedef {Object} PublicationBaseline
 * @property {string} head
 * @property {string} branch
 * @property {string} status
 * @property {Record<string, string | null>} files
 * @property {string[]} executionWorktrees
 * @property {string[]} executionCommits
 */

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
    const copy = new Uint8Array(bytes);
    const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} projectRoot
 * @returns {Promise<Record<string, ProjectSnapshotEntry>>}
 */
async function snapshotProjectRoot(projectRoot) {
    /** @type {Record<string, ProjectSnapshotEntry>} */
    const snapshot = {};
    /** @param {string} directory */
    async function visit(directory) {
        try {
            for await (const entry of Deno.readDir(directory)) {
                if (entry.name === ".git") continue;
                const path = join(directory, entry.name);
                const relativePath = relative(projectRoot, path);
                if (isCurrentProjectRuntimePath(relativePath)) continue;
                if (entry.isDirectory) {
                    snapshot[relativePath] = { kind: "dir" };
                    await visit(path);
                } else if (entry.isFile) {
                    const bytes = await Deno.readFile(path).catch((error) => {
                        if (error instanceof Deno.errors.NotFound) return null;
                        throw error;
                    });
                    if (bytes) snapshot[relativePath] = { kind: "file", hash: await sha256Hex(bytes) };
                }
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    }
    await visit(projectRoot);
    return snapshot;
}

/**
 * @param {Record<string, ProjectSnapshotEntry>} before
 * @param {Record<string, ProjectSnapshotEntry>} after
 */
function diffProjectSnapshots(before, after) {
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    /** @type {string[]} */
    const changes = [];
    for (const path of paths) {
        const previous = before[path];
        const current = after[path];
        if (!previous) changes.push(`added:${path}`);
        else if (!current) changes.push(`deleted:${path}`);
        else if (previous.kind !== current.kind || previous.hash !== current.hash) changes.push(`modified:${path}`);
    }
    return changes;
}

/** @param {unknown} value */
function isObject(value) {
    return Boolean(value && typeof value === "object");
}

/** @param {import('@earendil-works/pi-ai').TranscriptContext} context */
function getContextToolNames(context) {
    return getCurrentTools(context.messages).map((tool) => tool.name);
}

/** @param {import('@earendil-works/pi-ai').TranscriptContext} context */
function getContextSystemPrompt(context) {
    return getCurrentSystemPrompt(context.messages);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
async function runGoldenGit(args, cwd) {
    const output = await new Deno.Command("git", { args, cwd }).output();
    const stdout = new TextDecoder().decode(output.stdout).trim();
    const stderr = new TextDecoder().decode(output.stderr).trim();
    if (!output.success) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    return stdout;
}

/** @param {string} agentName */
function inferGoldenPhase(agentName) {
    if (agentName === "router") return "triage";
    if (agentName === "guide") return "inquiry";
    if (agentName === "planner") return "plan_review";
    return agentName || "unknown";
}

/**
 * @param {string | undefined} snapshotAgentName
 * @param {string[]} availableTools
 * @param {string} [systemPrompt]
 * @returns {{ agent: string, phase: string }}
 */
function inferGoldenTurnIdentity(snapshotAgentName, availableTools, systemPrompt = "") {
    // The Recorder runs in its own non-interactive session, so the composed
    // Session's snapshot still names whichever Agent was last active there. Its
    // system prompt is the only thing that distinguishes it — which is the same
    // signal a real model has, and it decides who to answer as, not what the
    // scenario asserts about the workflow.
    if (systemPrompt.includes("You are the Recorder")) return { agent: "recorder", phase: "work_record" };
    // Validation repairs run in an independent focused session. The composed
    // TUI snapshot can still name Guide (or another prior Agent), so use the
    // isolated session's system prompt to match the scripted repair turn.
    if (systemPrompt.includes("You are the Validation Repair Engineer")) {
        return { agent: "engineer", phase: "engineer" };
    }
    if (systemPrompt.includes("We are initializing RunWield into this project")) {
        return { agent: "init", phase: "init" };
    }
    if (systemPrompt.includes("You are the Software Engineer")) return { agent: "engineer", phase: "engineer" };
    // Approved Plans execute under the workflow-only Plan Engineer, whose runtime
    // name is `plan-engineer`. Scenarios script the execution phase as `engineer`
    // regardless of which Agent RunWield activates for it, the same way the
    // Validation Repair Engineer is matched above.
    if (systemPrompt.includes("You are the Plan Engineer")) return { agent: "engineer", phase: "engineer" };
    if (systemPrompt.includes("You are the Frontend Engineer")) return { agent: "engineer", phase: "engineer" };
    if (availableTools.includes("slicer_finalize_decomposition")) return { agent: "slicer", phase: "slicer" };
    if (availableTools.includes("plan_written")) {
        // Planner and Architect deliberately share the Plan tool surface. The
        // prompt identifies which planning Agent owns the turn; assuming every
        // plan_written turn is Planner made PROJECT Goldens unable to prove the
        // Router actually invoked Architect.
        if (systemPrompt.includes("You are the Architect")) return { agent: "architect", phase: "plan_review" };
        return { agent: "planner", phase: "plan_review" };
    }
    // Workflow Validation runs the Semantic Reviewer in an isolated session while
    // the composed Runtime still reports Engineer as the active Agent, so only the
    // tool set tells them apart. Giving the Reviewer its own identity keeps its
    // turns out of the Engineer's ordinal space — sharing it made a Reviewer turn
    // and an Engineer repair turn compete for the same ordinal, and the matcher
    // resolved that collision by tool set only after ordinal had already decided.
    if (availableTools.includes("review_complete")) return { agent: "reviewer", phase: "semantic_review" };
    // An approved Plan runs under the workflow-only Plan Engineer, so the Runtime
    // snapshot names `plan-engineer`. Scenarios script the Plan execution phase as
    // `engineer` whichever Agent RunWield activates for it, so fold the runtime
    // identity back before it opens a second ordinal series and strands the
    // scripted follow-up turn.
    const agent = snapshotAgentName === "plan-engineer" ? "engineer" : snapshotAgentName || "unknown";
    return { agent, phase: inferGoldenPhase(agent) };
}

/**
 * @typedef {Object} GoldenProviderOptions
 * @property {string} [runwieldDir]
 * @property {GoldenScenario["models"]} [models]
 * @property {number} [tokensPerSecond]
 */

/**
 * @param {GoldenProviderOptions} options
 * @returns {Promise<ReturnType<typeof registerFauxProvider>>}
 */
async function registerGoldenFauxProviderForEnvironment(options = {}) {
    if (options.runwieldDir) {
        await writeGoldenModelConfig(options.runwieldDir, { api: GOLDEN_FAUX_API, models: options.models });
    }
    return registerFauxProvider({
        api: GOLDEN_FAUX_API,
        provider: GOLDEN_FAUX_PROVIDER,
        tokensPerSecond: options.tokensPerSecond ?? 0,
        models: (options.models || [{ id: GOLDEN_FAUX_MODEL, name: "Golden Faux Model" }]).map((model) => ({
            ...model,
            input: ["text", "image"],
        })),
    });
}

/**
 * @param {GoldenScenario} scenario
 * @param {{ keepArtifacts?: boolean, artifactRoot?: string, heartbeatPath?: string, onReady?: () => void }} [options]
 * @returns {Promise<GoldenScenarioResult>}
 */
export async function runGoldenScenario(scenario, options = {}) {
    if (scenario.composedTui && Deno.env.get("WLD_GOLDEN_TUI_CHILD") !== "1") {
        throw new Error(
            "Composed Golden TUI scenarios must run through runGoldenScenarioChildProcess for subprocess isolation.",
        );
    }
    if (scenario.composedTui) return await runComposedTuiScenario(scenario, options);
    const actor = new GoldenScenarioActor(scenario.script || []);
    const expectedInteractions = [...(scenario.interactions || [])];
    /** @type {Record<string, unknown> & { screen: string, canceled: boolean, editorUsable: boolean }} */
    const state = { screen: "", canceled: false, editorUsable: true };
    /** @type {string[]} */
    const events = [];
    /** @type {string | null} */
    let artifactDir = null;
    const timeoutMs = scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
    options.onReady?.();
    const startedAt = Date.now();
    try {
        for (const action of scenario.actions || []) {
            if (Date.now() - startedAt > timeoutMs) throw new Error(`Scenario timed out after ${timeoutMs}ms.`);
            if (!isObject(action)) continue;
            const typed = /** @type {any} */ (action);
            if (typed.type === "modelTurn" || typed.type === "modelProviderTurn") {
                const response = actor.next({
                    agent: typed.agent,
                    phase: typed.phase,
                    availableTools: typed.availableTools || [],
                });
                events.push(`model:${typed.agent}:${typed.phase || ""}`);
                const turn = actor.consumed.at(-1);
                if (typed.type === "modelProviderTurn" && turn) {
                    const message = createFauxMessageForTurn(turn);
                    state.lastModelMessage = message;
                    events.push("model:faux-provider");
                }
                if (typeof response === "string") state.screen = `${state.screen || ""}\n${response}`;
                continue;
            }
            if (typed.type === "screen") {
                state.screen = `${state.screen || ""}\n${typed.text || ""}`;
                events.push("screen");
                continue;
            }
            if (typed.type === "cancel") {
                state.canceled = true;
                state.editorUsable = true;
                events.push("cancellation");
                continue;
            }
            if (typed.type === "slash") {
                state.screen = `${state.screen || ""}\n/${typed.command || ""}`;
                events.push(`slash:${typed.command || ""}`);
                continue;
            }
            if (typed.type === "interaction") {
                const expected = expectedInteractions.shift();
                if (expected) {
                    if (
                        expected.interactionType !== typed.interactionType ||
                        (expected.decision && expected.decision !== typed.decision)
                    ) {
                        throw new Error(
                            `Unexpected interaction: expected ${expected.interactionType}:${
                                expected.decision || ""
                            }, got ${typed.interactionType || ""}:${typed.decision || ""}`,
                        );
                    }
                } else if (scenario.interactions) {
                    throw new Error(`Unexpected interaction: ${typed.interactionType || ""}:${typed.decision || ""}`);
                }
                events.push(`interaction:${typed.interactionType || ""}:${typed.decision || ""}`);
                state.lastInteraction = typed;
                continue;
            }
            if (typed.type === "planReviewTransaction") {
                const decisions = typed.decisions || [];
                const reviewSurface = new ScriptedReviewSurface(decisions);
                const planDir = await Deno.makeTempDir({ prefix: "runwield-golden-plan-review-" });
                const plansDir = join(planDir, "docs", "plans");
                await Deno.mkdir(plansDir, { recursive: true });
                const planPath = join(plansDir, "plan.md");
                await Deno.writeTextFile(planPath, typed.plan || "# Plan\n\nDo the thing.\n");
                const lifecycleEvents = [];
                try {
                    for (let reviewIndex = 0; reviewIndex < decisions.length; reviewIndex += 1) {
                        const triageMeta = typed.triageMeta || {
                            classification: "FEATURE",
                            complexity: "LOW",
                            summary: "Golden Plan Review contract",
                        };
                        const result = await submitPlanForReview({
                            cwd: planDir,
                            planName: "plan",
                            planPath,
                            triageMeta,
                            browser: createGoldenReviewBrowser(
                                reviewSurface,
                                null,
                                { cwd: planDir, planName: "plan", planPath, triageMeta },
                                typed.reviewedPlan,
                            ),
                        });
                        const lifecycleEvent = result.approved ? "review_approved" : "review_feedback";
                        lifecycleEvents.push({ event: lifecycleEvent });
                        events.push(`interaction:PLAN_REVIEW:${result.approved ? "approved" : "feedback"}`);
                        events.push(lifecycleEvent);
                    }
                    reviewSurface.assertComplete();
                    const parsed = parsePlanFrontMatter(await Deno.readTextFile(planPath));
                    state.planReview = { attrs: parsed.attrs, lifecycleEvents, consumed: reviewSurface.consumed };
                    state.screen = `${state.screen || ""}\n${lifecycleEvents.map((event) => event.event).join("\n")}`;
                } finally {
                    await Deno.remove(planDir, { recursive: true }).catch(() => {});
                }
                continue;
            }
            throw new Error(`Unknown scenario action: ${typed.type}`);
        }
        actor.assertComplete();
        if (expectedInteractions.length) {
            throw new Error(
                `Missing expected interactions: ${
                    expectedInteractions.map((item) => `${item.interactionType}:${item.decision || ""}`).join(",")
                }`,
            );
        }
        const result = {
            name: scenario.name,
            state,
            events,
            screenText: normalizeScreenText(String(state.screen || "")),
            actor: actor.diagnostics(),
            artifactDir,
        };
        for (const assertion of scenario.assertions || []) await assertion(result);
        return result;
    } catch (error) {
        if (options.keepArtifacts !== false) {
            artifactDir = await Deno.makeTempDir({
                dir: options.artifactRoot,
                prefix: "runwield-golden-tui-failure-",
            });
            await Deno.writeTextFile(
                join(artifactDir, "diagnostics.json"),
                JSON.stringify(
                    {
                        scenario: scenario.name,
                        error: error instanceof Error ? error.message : String(error),
                        screenText: normalizeScreenText(String(state.screen || "")),
                        events,
                        actor: actor.diagnostics(),
                        state,
                    },
                    null,
                    2,
                ),
            );
        }
        throw error;
    }
}

/**
 * @param {GoldenScenario["priorSession"]} priorSession
 * @param {ReturnType<typeof registerFauxProvider>} fauxProvider
 */
async function seedGoldenPriorSession(priorSession, fauxProvider) {
    if (!priorSession) return null;
    const sessionStore = openFileSessionStore();
    const runtime = createSessionRuntime({ sessionStore, ownerProcessKind: "tui" });
    try {
        fauxProvider.setResponses([
            () =>
                createFauxMessageForTurn({
                    id: "prior-session-seed",
                    agent: priorSession.agentName || "guide",
                    phase: priorSession.agentName || "guide",
                    text: priorSession.assistantText,
                }),
            ...(priorSession.planName
                ? [() =>
                    createFauxMessageForTurn({
                        id: "prior-session-plan-context",
                        agent: "planner",
                        phase: "plan_review",
                        text: "Persisted the Plan context for a later resumed turn.",
                    })]
                : []),
        ]);
        const created = await runtime.createInteractiveSession({ cwd: Deno.cwd(), mode: "new" });
        if (priorSession.agentName) await runtime.switchAgent(created.sessionId, { agentName: priorSession.agentName });
        await runtime.promptSession(created.sessionId, { initialRequest: priorSession.userText });
        if (priorSession.planName) {
            await runtime.runPlanningAgent(created.sessionId, {
                agentName: "planner",
                initialRequest: `Preserve Plan context for ${priorSession.planName}.`,
                planName: priorSession.planName,
                triageMeta: {
                    classification: priorSession.classification || "PLANNED_CHANGE",
                    complexity: priorSession.complexity || "MEDIUM",
                },
            });
            if (priorSession.agentName) {
                await runtime.switchAgent(created.sessionId, { agentName: priorSession.agentName });
            }
        }
        // The fixture's model describes the saved final Agent. Plan-context
        // setup can switch Agents, so select it after those transitions just
        // as the user would before closing the Session.
        if (priorSession.model) {
            await runtime.reconfigureSessionModel(
                created.sessionId,
                priorSession.model,
                priorSession.provider || GOLDEN_FAUX_PROVIDER,
            );
        }
        let interrupted = false;
        if (priorSession.interrupted) {
            fauxProvider.setResponses([() =>
                createFauxMessageForTurn({
                    id: "prior-session-interrupted-turn",
                    agent: priorSession.agentName || "guide",
                    phase: priorSession.agentName || "guide",
                    text: "This response should be interrupted before it completes. ".repeat(200),
                })]);
            let resolveStreaming = () => {};
            const streaming = new Promise((resolve) => {
                resolveStreaming = () => resolve(undefined);
            });
            const unsubscribe = runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA) resolveStreaming();
            });
            const interruptedTurn = runtime.promptSession(created.sessionId, {
                initialRequest: "This request is interrupted before restart.",
            });
            try {
                await Promise.race([
                    streaming,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Golden interrupted turn did not start streaming.")), 3_000)
                    ),
                ]);
                const cancellation = runtime.cancelSession(created.sessionId);
                await interruptedTurn.catch(() => {});
                interrupted = cancellation.ok === true && cancellation.aborted === true;
            } finally {
                unsubscribe();
            }
            if (!interrupted) throw new Error("Golden prior Session turn could not be interrupted.");
        }

        const replay = await runtime.replaySession(created.sessionId);
        const snapshot = runtime.getSessionSnapshot(created.sessionId);
        await runtime.closeAllSessionsWhenIdle();

        return {
            sessionId: created.sessionId,
            replayed: replay.replayed || 0,
            managed: snapshot?.managed || null,
            workflowContext: snapshot?.workflowContext || null,
            activeAgent: snapshot?.activeAgent || null,
            activeModel: snapshot?.activeModel || null,
            interrupted,
        };
    } finally {
        sessionStore.close?.();
    }
}

/** @param {ReturnType<typeof registerFauxProvider>} fauxProvider */
async function seedGoldenCorruptSession(fauxProvider) {
    const sessionStore = openFileSessionStore();
    const runtime = createSessionRuntime({ sessionStore, ownerProcessKind: "tui" });
    try {
        fauxProvider.setResponses([() =>
            createFauxMessageForTurn({
                id: "corrupt-session-seed",
                agent: "guide",
                phase: "inquiry",
                text: "This transcript will be corrupted after it is safely closed.",
            })]);
        const created = await runtime.createInteractiveSession({ cwd: Deno.cwd(), mode: "new" });
        await runtime.switchAgent(created.sessionId, { agentName: "guide" });
        await runtime.promptSession(created.sessionId, { initialRequest: "seed corrupt resume fixture" });
        const sessionManagerId = runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId;
        const sessions = await runtime.listResumableSessions(Deno.cwd());
        const persisted = sessions.find((session) => session.id === sessionManagerId);
        await runtime.closeAllSessionsWhenIdle();
        if (!persisted) throw new Error("Golden corrupt Session fixture was not persisted.");
        await Deno.writeTextFile(persisted.path, "{corrupt-json\n");
        return { id: persisted.id, path: persisted.path };
    } finally {
        sessionStore.close?.();
    }
}

/**
 * @param {GoldenScenario} scenario
 * @param {{ keepArtifacts?: boolean, artifactRoot?: string, heartbeatPath?: string, onReady?: () => void }} options
 * @returns {Promise<GoldenScenarioResult>}
 */
async function runComposedTuiScenario(scenario, options) {
    return await withProcessGlobalTestLock(async () => {
        const useCurrentEnvironment = Deno.env.get("WLD_GOLDEN_TUI_CHILD") === "1";
        const previousHome = Deno.env.get("HOME");
        const previousCwd = Deno.cwd();
        const env = useCurrentEnvironment
            ? null
            : await createGoldenIsolatedEnvironment({ keep: options.keepArtifacts });
        if (env) {
            for (const [key, value] of Object.entries(env.env)) Deno.env.set(key, value);
            Deno.chdir(env.projectRoot);
        }
        const runwieldDir = env?.runwieldDir || Deno.env.get("RUNWIELD_HOME") || null;
        const initStatePath = runwieldDir ? join(runwieldDir, "init-state.json") : null;
        if (initStatePath) {
            const { _setTestStatePath } = await import("../../../cmd/init/init-state.ts");
            _setTestStatePath(initStatePath);
        }
        for (const fixture of scenario.initialProjectFiles || []) {
            if (!isObject(fixture)) continue;
            const path = join(Deno.cwd(), String(/** @type {any} */ (fixture).path || ""));
            await Deno.mkdir(join(path, ".."), { recursive: true });
            await Deno.writeTextFile(path, String(/** @type {any} */ (fixture).text || ""));
        }
        // Committed baseline state, as opposed to `initialProjectFiles`, which stay
        // dirty in the primary checkout. Publication runs in an isolated clone and
        // must leave those dirty files untouched; committed fixtures establish the
        // remote history that the execution branch is built from.
        const committedProjectFiles = scenario.committedProjectFiles || [];
        if (committedProjectFiles.length > 0) {
            for (const fixture of committedProjectFiles) {
                if (!isObject(fixture)) continue;
                const path = join(Deno.cwd(), String(/** @type {any} */ (fixture).path || ""));
                await Deno.mkdir(join(path, ".."), { recursive: true });
                await Deno.writeTextFile(path, String(/** @type {any} */ (fixture).text || ""));
            }
            await runGoldenGit(["add", "-A"], Deno.cwd());
            await runGoldenGit(["commit", "-m", "Golden fixture baseline"], Deno.cwd());
            await runGoldenGit(["push", "origin", "main"], Deno.cwd());
        }
        if (scenario.nonGitProject) {
            await Deno.remove(join(Deno.cwd(), ".git"), { recursive: true }).catch(() => {});
        }
        if (runwieldDir && scenario.modelSetup === "none") {
            await Deno.remove(join(runwieldDir, "models.json")).catch(() => {});
            await Deno.writeTextFile(
                join(runwieldDir, "settings.json"),
                JSON.stringify({ theme: "default", notifications: { enabled: false } }),
            );
        } else if (runwieldDir && scenario.modelSetup === "provider-without-models") {
            await Deno.writeTextFile(
                join(runwieldDir, "models.json"),
                JSON.stringify({ providers: { empty: { name: "Empty Golden Provider", apiKey: "golden-test-key" } } }),
            );
            await Deno.writeTextFile(
                join(runwieldDir, "settings.json"),
                JSON.stringify({ theme: "default", notifications: { enabled: false } }),
            );
        } else if (runwieldDir && scenario.globalSettings) {
            await Deno.writeTextFile(
                join(runwieldDir, "settings.json"),
                JSON.stringify({
                    theme: "default",
                    notifications: { enabled: false },
                    ...scenario.globalSettings,
                }),
            );
        }
        if (runwieldDir && scenario.onboardingOfferHandled !== false) {
            const settingsPath = join(runwieldDir, "settings.json");
            let settings = {};
            try {
                settings = JSON.parse(await Deno.readTextFile(settingsPath));
            } catch {
                settings = {};
            }
            await Deno.writeTextFile(
                settingsPath,
                JSON.stringify({
                    ...settings,
                    onboardingTutorialOfferHandled: true,
                }),
            );
        }
        // Runtime entry is startup state, not a scenario mutation. Complete it
        // before concurrent UI reads begin and before the project baseline is saved.
        await enterProjectRuntime(getCwd());
        const projectSnapshotBefore = await snapshotProjectRoot(Deno.cwd());
        const fauxProvider = scenario.modelSetup === "none" || scenario.modelSetup === "provider-without-models"
            ? null
            : await registerGoldenFauxProviderForEnvironment({
                runwieldDir: runwieldDir || undefined,
                models: scenario.models,
                tokensPerSecond: scenario.modelTokensPerSecond,
            });
        const priorSessionState = fauxProvider
            ? await seedGoldenPriorSession(scenario.priorSession, fauxProvider)
            : null;
        const corruptSessionState = scenario.corruptSession && fauxProvider
            ? await seedGoldenCorruptSession(fauxProvider)
            : null;
        const actor = new GoldenScenarioActor(scenario.script || []);
        /** @type {Map<string, number>} */
        const turnOrdinals = new Map();
        const { createInteractiveTuiComposition } = await import("../interactive-tui-composition.ts");
        let terminal = new VirtualTerminal(scenario.terminal);
        /** @type {Awaited<ReturnType<typeof createInteractiveTuiComposition>> | null} */
        let composition = null;
        /** @type {Map<string, { terminal: VirtualTerminal, composition: Awaited<ReturnType<typeof createInteractiveTuiComposition>>, unsubscribe: () => void }>} */
        const concurrentSessions = new Map();
        /** @type {string[]} */
        const events = [];
        /** @type {string[]} */
        const turnSequence = [];
        /** @type {string} */
        let lastWorkflowPlanName = "";
        /** @type {ComposedScenarioState} */
        const state = {
            canceled: false,
            editorUsable: true,
            cleanupSucceeded: false,
            priorSession: priorSessionState,
            corruptSession: corruptSessionState,
            turnSequence,
        };
        /** @type {() => void} */
        let unsubscribe = () => {};
        /** @type {string | null} */
        let artifactDir = null;
        let restartedTuiHistory = "";
        /** @type {Array<{ event: string, status?: unknown, updatedAt?: unknown }>} */
        const persistedLifecycleEvents = [];
        const writeHeartbeat = async () => {
            if (!options.heartbeatPath) return;
            await Deno.mkdir(join(options.heartbeatPath, ".."), { recursive: true }).catch(() => {});
            await Deno.writeTextFile(
                options.heartbeatPath,
                JSON.stringify(
                    {
                        scenario: scenario.name,
                        screenText: terminal.getScreenText(),
                        scrollback: terminal.getScrollbackText?.(),
                        events,
                        state,
                        actor: actor.diagnostics(),
                        runtime: composition?.runtime.getSessionSnapshot(composition.sessionId),
                        cwd: Deno.cwd(),
                        home: Deno.env.get("HOME"),
                    },
                    null,
                    2,
                ),
            ).catch(() => {});
        };
        const reviewSurface = scenario.reviewDecisions
            ? new ScriptedReviewSurface(/** @type {any[]} */ (scenario.reviewDecisions))
            : null;
        /** @type {Array<ReturnType<ScriptedReviewSurface['submit']>>} */
        const pendingReviewLifecycleObservations = [];
        /** @param {ReturnType<ScriptedReviewSurface['submit']>} response */
        const observeReviewDecision = (response) => {
            const event = response.approved ? "review_approved" : "review_feedback";
            events.push(`interaction:PLAN_REVIEW:${response.approved ? "approved" : "feedback"}`);
            events.push(event);
            pendingReviewLifecycleObservations.push(response);
        };
        const humanReviewSurface = scenario.humanReviewDecisions
            ? new ScriptedHumanReviewSurface(/** @type {any[]} */ (scenario.humanReviewDecisions))
            : null;
        /** @type {Array<ReturnType<ScriptedHumanReviewSurface['submit']>>} */
        const consumedHumanReviews = [];
        /** @param {ReturnType<ScriptedHumanReviewSurface['submit']>} response */
        const observeHumanReviewDecision = (response) => {
            events.push(
                `interaction:CODE_REVIEW:${
                    response.approved ? "approved" : response.canceled ? "canceled" : "feedback"
                }`,
            );
            events.push("human-review:captured");
            consumedHumanReviews.push(response);
        };
        const interactionSurface = scenario.scriptedInteractions
            ? new ScriptedInteractionSurface(
                /** @type {any[]} */ (scenario.scriptedInteractions),
                (planName) => {
                    const activeComposition = composition;
                    const executionCwd = activeComposition?.runtime.getSessionSnapshot(activeComposition.sessionId)
                        ?.activeExecutionWorkflow?.executionCwd;
                    if (typeof executionCwd === "string" && executionCwd) return executionCwd;
                    if (planName) {
                        const registryText = Deno.readTextFileSync(getWorktreeRegistryPath(getCwd()));
                        const parsed = /** @type {{ entries?: Array<{ planName?: string, path?: string }> }} */ (
                            JSON.parse(registryText)
                        );
                        const matches = (parsed.entries || []).filter((entry) => entry.planName === planName);
                        const durablePath = matches.at(-1)?.path;
                        if (durablePath) return durablePath;
                    }
                    return getCwd();
                },
            )
            : null;
        if (interactionSurface) state.scriptedInteractions = interactionSurface.consumed;
        /** @type {"select"|"text"|"approval"|null} */
        let activeScriptedInteractionType = null;
        /** @param {import('../types.js').UiAPI} uiAPI */
        const configureScriptedUiAPI = (uiAPI) => {
            if (scenario.captureSystemMessages) {
                const originalAppendSystemMessage = uiAPI.appendSystemMessage.bind(uiAPI);
                uiAPI.appendSystemMessage = (text, isError = false, header, style) => {
                    const systemMessages = Array.isArray(state.systemMessages) ? state.systemMessages : [];
                    const entry = {
                        text: String(text),
                        isError: isError === true,
                        ...(typeof header === "string" ? { header } : {}),
                    };
                    systemMessages.push(entry);
                    state.systemMessages = systemMessages;
                    return originalAppendSystemMessage(text, isError, header, style);
                };
            }
            if (!interactionSurface) return;
            const originalPromptSelect = uiAPI.promptSelect.bind(uiAPI);
            uiAPI.promptSelect = (prompt, options, hooks) => {
                if (scenario.interactiveSelectPrompts?.some((fragment) => prompt.includes(fragment))) {
                    const type = activeScriptedInteractionType || "select";
                    const next = interactionSurface.interactions[0];
                    const expected = next?.type === type && next.promptIncludes && prompt.includes(next.promptIncludes)
                        ? next
                        : null;
                    return originalPromptSelect(prompt, options, hooks).then((value) => {
                        if (expected) {
                            const expectedValue = expected.value === "__first_option__"
                                ? options?.[0]?.value ?? null
                                : expected.value ?? null;
                            if (value !== expectedValue) {
                                throw new Error(`Interactive select returned ${value}; expected ${expectedValue}`);
                            }
                            if (interactionSurface.interactions[0] !== expected) {
                                throw new Error("Scripted interaction changed while its real prompt was open.");
                            }
                            // Consume only after the real terminal decision matches the expectation.
                            interactionSurface.next(type, { prompt, options });
                        }
                        return value;
                    });
                }
                const value = interactionSurface.next(activeScriptedInteractionType || "select", {
                    prompt,
                    options,
                });
                if (value === null) return Promise.resolve(null);
                const resolvedValue = value === "__first_option__" ? options?.[0]?.value : value;
                if (!Array.isArray(options) || !options.some((option) => option.value === resolvedValue)) {
                    throw new Error(`Scripted select returned invalid option: ${resolvedValue}`);
                }
                return Promise.resolve(resolvedValue);
            };
            uiAPI.promptText = (prompt, options) => {
                const value = interactionSurface.next("text", { prompt, options });
                return Promise.resolve(value === null ? null : String(value));
            };
        };
        try {
            // Every scripted turn is served through the faux provider, including the
            // Slicer's. Excluding it meant the harness consumed that turn itself and
            // called saveChildFeaturePlans directly, so the real
            // slicer_finalize_decomposition tool and the Epic decomposition
            // transaction never ran in any Golden scenario.
            // Extra slots allow ancillary Recorder calls; they must still pass
            // through the same strict actor dispatch as every other model turn.
            const scriptedResponseFactories = Array.from({ length: (scenario.script || []).length + 8 }, () =>
            (
                /** @type {import('@earendil-works/pi-ai').TranscriptContext} */ context,
                /** @type {unknown} */ _options,
                /** @type {unknown} */ _providerState,
                /** @type {{ id?: string, provider?: string }} */ model,
            ) => {
                let snapshot = composition?.runtime.getSessionSnapshot(composition.sessionId);
                const availableTools = getContextToolNames(context);
                const systemPrompt = getContextSystemPrompt(context);
                // Route the external model fixture by the request's real working
                // directory. Concurrent sessions must never borrow the first TUI's
                // Plan identity or consume its scripted turns.
                if (concurrentSessions.size > 0) {
                    const requestCwd = systemPrompt.match(/^Current working directory: (.+)$/m)?.[1]?.trim() ||
                        systemPrompt.match(/<cwd>\s*([\s\S]*?)\s*<\/cwd>/)?.[1]?.trim();
                    const snapshots = [
                        snapshot,
                        ...[...concurrentSessions.values()].map(({ composition: sessionComposition }) =>
                            sessionComposition.runtime.getSessionSnapshot(sessionComposition.sessionId)
                        ),
                    ].filter((candidate) =>
                        candidate && requestCwd && Deno.realPathSync(candidate.cwd) === Deno.realPathSync(requestCwd)
                    );
                    if (snapshots.length === 1) snapshot = snapshots[0];
                    else if (availableTools.includes("task_completed") || availableTools.includes("review_complete")) {
                        const message = `Cannot route concurrent model request for ${requestCwd || "missing cwd"}`;
                        events.push(`model:fixture-error:${message}`);
                        void writeHeartbeat().catch(() => {});
                        throw new Error(message);
                    }
                }
                const { agent, phase } = inferGoldenTurnIdentity(
                    snapshot?.activeAgent || undefined,
                    availableTools,
                    systemPrompt,
                );
                const checklistTool = availableTools.includes("manual_qa_completed")
                    ? "manual_qa_completed"
                    : availableTools.includes("qa_checklist_generated")
                    ? "qa_checklist_generated"
                    : null;
                if (
                    checklistTool &&
                    !actor.remaining.some((turn) => turn.toolCalls?.some((call) => call.name === checklistTool))
                ) {
                    events.push("model:faux-provider:manual-qa:manual_qa");
                    return createFauxMessageForTurn({
                        id: "golden-default-manual-qa",
                        agent: "manual-qa",
                        phase: "manual_qa",
                        toolCalls: [{
                            name: checklistTool,
                            arguments: {
                                checklistMarkdown: `Manual verification steps for ${
                                    lastWorkflowPlanName || "the completed Plan"
                                }\n\n- [ ] Verify the completed behavior.`,
                            },
                        }],
                    });
                }
                // Most scenarios do not prescribe prose for the Work Record.
                // Only that ancillary model response has a default: persistence,
                // indexing, and linking still run through the production tool.
                if (
                    availableTools.includes("work_record_completed") &&
                    !actor.remaining.some((turn) => turn.agent === "recorder")
                ) {
                    events.push("model:faux-provider:recorder:work_record");
                    return createFauxMessageForTurn({
                        id: "golden-default-work-record",
                        agent: "recorder",
                        phase: "work_record",
                        toolCalls: [{
                            name: "work_record_completed",
                            arguments: {
                                title: "Golden Work Record",
                                summary: "Recorded the completed Golden Planned Change for planning memory.",
                                deviationsFromPlan: "None.",
                            },
                        }],
                    });
                }
                if (scenario.captureModelTurns) {
                    const modelTurns = Array.isArray(state.modelTurns) ? state.modelTurns : [];
                    modelTurns.push({
                        agent,
                        phase,
                        runtimeAgent: snapshot?.activeAgent || "",
                        model: model?.id || "",
                        provider: model?.provider || "",
                        systemPrompt,
                    });
                    state.modelTurns = modelTurns;
                }
                // The Runtime's own view of which Plan is executing. An Epic drives
                // several child Plans through the same Agent and phase, so execution
                // and review turns count ordinals per Plan: one child's turn count
                // then cannot shift the next child's script. Planning turns are not
                // scoped this way — a Planner turn runs before its Plan exists, and
                // the Runtime still reports whichever Plan came before.
                const reportedPlanName = String(
                    /** @type {{ workflowContext?: { planName?: unknown }, activeExecutionWorkflow?: { planName?: unknown } }} */ (
                        snapshot || {}
                    ).workflowContext?.planName ||
                        /** @type {{ activeExecutionWorkflow?: { planName?: unknown } }} */ (snapshot || {})
                            .activeExecutionWorkflow?.planName ||
                        "",
                );
                // The Runtime clears workflowContext between phases while retaining
                // activeExecutionWorkflow. An empty reading must not open a second
                // ordinal series for the same Plan — that silently shifts later
                // turns. Carry the last Plan the Runtime named until it names another.
                if (reportedPlanName) lastWorkflowPlanName = reportedPlanName;
                const planName = reportedPlanName || lastWorkflowPlanName;
                const planScoped = agent === "engineer" || agent === "reviewer";
                const ordinalKey = planScoped ? `${agent}:${phase}:${planName}` : `${agent}:${phase}`;
                const ordinal = (turnOrdinals.get(ordinalKey) || 0) + 1;
                turnOrdinals.set(ordinalKey, ordinal);
                // Recorded before dispatch so a failing turn still appears: the
                // identity/ordinal a turn was offered under is the one fact needed to
                // script agent loops that run to a text-only answer, and it is
                // invisible from events alone.
                turnSequence.push(`${agent}:${phase}:${planScoped ? planName || "-" : "*"}:${ordinal}`);
                const response = actor.next({
                    agent,
                    phase,
                    ordinal,
                    planName: planScoped ? planName : undefined,
                    availableTools,
                });
                events.push(`model:faux-provider:${agent}:${phase}`);
                return createFauxMessageForTurn(actor.consumed.at(-1) || /** @type {any} */ ({ response }));
            });
            fauxProvider?.setResponses(scriptedResponseFactories);
            // The welcome prompt blocks inside createInteractiveTuiComposition while
            // scenario actions only run after it resolves, so startup-declared input
            // has to be fed while the composition promise is still in flight. Input
            // sent before the TUI attaches its handler to the VirtualTerminal is
            // dropped, so every step waits for a screen marker first. The observed
            // screen at each marker is recorded for assertions, and an
            // expected-clean-exit scenario reports it to the parent before feeding
            // the input that will drive the real /quit (Deno.exit(0)).
            const startupInputSteps = scenario.startupInput || [];
            const startupInputPromise = (async () => {
                for (const step of startupInputSteps) {
                    const marker = String(step.marker || "");
                    const startedAt = Date.now();
                    let markerObserved = false;
                    while (Date.now() - startedAt < (scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS)) {
                        await terminal.flush();
                        const screen = terminal.getScreenText();
                        if (screen.includes(marker)) {
                            markerObserved = true;
                            state.startupScreen = screen;
                            state.startupScrollback = terminal.getScrollbackText();
                            events.push(`startup:marker:${marker}`);
                            // Report the observed screen before feeding input: an
                            // expected-clean-exit scenario dies inside the real /quit
                            // (Deno.exit(0)) shortly after its input lands, and the
                            // pre-exit report is the parent's only evidence.
                            if (scenario.expectedCleanExit) {
                                await writeHeartbeat();
                                console.log(JSON.stringify({
                                    ok: true,
                                    expectedCleanExit: true,
                                    result: {
                                        name: scenario.name,
                                        state,
                                        events,
                                        screenText: screen,
                                        scrollbackText: state.startupScrollback,
                                        actor: actor.diagnostics(),
                                        artifactDir: null,
                                    },
                                    env: {
                                        root: runwieldDir ? join(runwieldDir, "..", "..") : null,
                                        projectRoot: Deno.cwd(),
                                    },
                                    heartbeatArtifactDir: options.artifactRoot || null,
                                }));
                            }
                            if (step.keys) terminal.input(String(step.keys));
                            else if (step.text) terminal.typeText(String(step.text));
                            await terminal.flush();
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    if (!markerObserved) {
                        throw new Error(
                            `Startup input marker never appeared: ${
                                JSON.stringify(marker)
                            }. Screen:\n${terminal.getScreenText()}`,
                        );
                    }
                }
            })();
            const compositionPromise = createInteractiveTuiComposition(null, {
                terminal,
                sessionStartMode: scenario.sessionStartMode || "new",
                initialAgentName: scenario.initialAgentName || "router",
                initialAgentModel: scenario.modelSetup === "none" || scenario.modelSetup === "provider-without-models"
                    ? undefined
                    : `${GOLDEN_FAUX_PROVIDER}/${GOLDEN_FAUX_MODEL}`,
                skipModelWelcome: scenario.skipModelWelcome === true,
                configureUiAPI: configureScriptedUiAPI,
                browser: reviewSurface || humanReviewSurface
                    ? createGoldenReviewBrowser(
                        reviewSurface,
                        humanReviewSurface,
                        {},
                        scenario.reviewedPlan,
                        observeReviewDecision,
                        observeHumanReviewDecision,
                    )
                    : NO_OPEN_BROWSER_PORT,
            });
            composition = await compositionPromise;
            await startupInputPromise;
            await writeHeartbeat();
            // Startup is done and the heartbeat carries real actor state, so the
            // parent can switch from its startup budget to the scenario budget.
            options.onReady?.();
            const runtime = composition.runtime;
            /** @param {import('../../../shared/session/session-runtime-events.js').SessionRuntimeEvent} event */
            const handleRuntimeEvent = (event) => {
                events.push(`runtime:${event.type}`);
                if (event.type === "agent_changed") {
                    const name = /** @type {{ agentName?: string }} */ (event).agentName || "";
                    events.push(`runtime:agent:${name}`);
                    state.activeAgent = name;
                }
                if (event.type === "cancellation") {
                    state.canceled = true;
                    events.push("runtime:cancellation");
                }
                if (event.type === "tool_start") {
                    const name = /** @type {{ toolName?: string }} */ (event).toolName || "";
                    events.push(`runtime:tool:start:${name}`);
                }
                if (event.type === "tool_end") {
                    const name = /** @type {{ toolName?: string }} */ (event).toolName || "";
                    events.push(`runtime:tool:end:${name}`);
                    if (event.toolCallId.startsWith("validation-ci-")) {
                        events.push(`runtime:validation-ci:${event.isError ? "failed" : "passed"}`);
                        (state.validationCiRuns ||= []).push({ output: event.output, isError: event.isError });
                    }
                }
                if (event.type === "assistant_text_delta") events.push("runtime:assistant:text");
                if (event.type === "assistant_thinking_delta") events.push("runtime:assistant:thinking");
                if (event.type === "queued_message_changed") events.push("runtime:queue");
                if (event.type === "interaction_resolved") {
                    const interaction =
                        /** @type {{ interactionType?: string, outcome?: string, message?: string }} */ (
                            event
                        );
                    events.push(
                        `runtime:interaction:${interaction.interactionType || "unknown"}:${
                            interaction.outcome || "unknown"
                        }`,
                    );
                    if (interaction.message) events.push(`runtime:interaction-message:${interaction.message}`);
                    if (interaction.interactionType === "plan_review") {
                        const response = pendingReviewLifecycleObservations.shift();
                        if (response) {
                            const eventName = response.approved ? "review_approved" : "review_feedback";
                            const expectedStatus = response.approved ? "approved" : "feedback";
                            const lifecycle = findFixturePlanLifecycle(
                                join(Deno.cwd(), "docs", "plans"),
                                expectedStatus,
                            );
                            persistedLifecycleEvents.push({
                                event: eventName,
                                status: lifecycle.status,
                                updatedAt: lifecycle.updatedAt,
                            });
                        }
                    }
                }
                if (event.type === "session_replaced") {
                    const replaced =
                        /** @type {{ oldSessionId?: string, newSessionId?: string, reason?: string, childPlanName?: string, action?: string }} */ (event);
                    state.replacedSession = {
                        previousSessionId: replaced.oldSessionId,
                        currentSessionId: replaced.newSessionId,
                        reason: replaced.reason,
                        childPlanName: replaced.childPlanName,
                        action: replaced.action,
                    };
                    events.push(`runtime:session-replaced:${replaced.reason || "unknown"}`);
                    if (replaced.newSessionId) {
                        const unsubscribePreviousSessions = unsubscribe;
                        const unsubscribeReplacement = runtime.subscribeSessionEvents(
                            replaced.newSessionId,
                            handleRuntimeEvent,
                        );
                        unsubscribe = () => {
                            unsubscribePreviousSessions();
                            unsubscribeReplacement();
                        };
                    }
                }
            };
            unsubscribe = runtime.subscribeSessionEvents(composition.sessionId, handleRuntimeEvent);
            for (const action of scenario.actions || []) {
                if (!isObject(action)) continue;
                const typed = /** @type {any} */ (action);
                if (typed.type === "type") {
                    const text = String(typed.text || "");
                    terminal.typeText(text);
                    const loadPlanMatch = text.trim().match(/^\/load-plan\s+(.+)$/);
                    if (loadPlanMatch) lastWorkflowPlanName = loadPlanMatch[1].trim();
                    events.push(`terminal:type:${typed.text || ""}`);
                } else if (typed.type === "clearEditor") {
                    terminal.input("\x15");
                    events.push("terminal:clear-editor");
                } else if (typed.type === "startConcurrentSession") {
                    const name = String(typed.name || `session-${concurrentSessions.size + 1}`);
                    const concurrentTerminal = new VirtualTerminal(typed.terminal || scenario.terminal);
                    const { stopTUI } = await import("../tui.ts");
                    stopTUI();
                    const concurrentComposition = await createInteractiveTuiComposition(null, {
                        browser: NO_OPEN_BROWSER_PORT,
                        terminal: concurrentTerminal,
                        sessionStartMode: typed.sessionStartMode || "new",
                        initialAgentName: typed.initialAgentName || scenario.initialAgentName || "router",
                        initialAgentModel:
                            scenario.modelSetup === "none" || scenario.modelSetup === "provider-without-models"
                                ? undefined
                                : `${GOLDEN_FAUX_PROVIDER}/${GOLDEN_FAUX_MODEL}`,
                        configureUiAPI: configureScriptedUiAPI,
                    });
                    const concurrentUnsubscribe = concurrentComposition.runtime.subscribeSessionEvents(
                        concurrentComposition.sessionId,
                        (event) => {
                            events.push(`concurrent:${name}:runtime:${event.type}`);
                            if (event.type === "tool_start") {
                                const eventToolName = /** @type {{ toolName?: string }} */ (event).toolName || "";
                                events.push(`concurrent:${name}:runtime:tool:start:${eventToolName}`);
                            }
                        },
                    );
                    for (let attempt = 0; !concurrentTerminal.started && attempt < 100; attempt += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    if (!concurrentTerminal.started) throw new Error("Concurrent terminal did not start.");
                    concurrentSessions.set(name, {
                        terminal: concurrentTerminal,
                        composition: concurrentComposition,
                        unsubscribe: concurrentUnsubscribe,
                    });
                    state.concurrentSessions = [...concurrentSessions.keys()];
                    events.push(`tui:concurrent-session:${name}:started`);
                } else if (typed.type === "concurrentType") {
                    const session = concurrentSessions.get(String(typed.name || ""));
                    if (!session) throw new Error(`Unknown concurrent session: ${typed.name || ""}`);
                    session.terminal.typeText(String(typed.text || ""));
                    events.push(`concurrent:${typed.name}:terminal:type:${typed.text || ""}`);
                } else if (typed.type === "concurrentEnter") {
                    const session = concurrentSessions.get(String(typed.name || ""));
                    if (!session) throw new Error(`Unknown concurrent session: ${typed.name || ""}`);
                    session.terminal.pressEnter();
                } else if (typed.type === "waitForConcurrentIdle") {
                    const session = concurrentSessions.get(String(typed.name || ""));
                    if (!session) throw new Error(`Unknown concurrent session: ${typed.name || ""}`);
                    await session.composition.waitForIdle(
                        typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS,
                    );
                } else if (typed.type === "captureConcurrentScreens") {
                    state.concurrentScreens = Object.fromEntries(
                        [...concurrentSessions.entries()].map(([name, session]) => [
                            name,
                            {
                                screenText: session.terminal.getScreenText(),
                                scrollbackText: session.terminal.getScrollbackText(),
                                snapshot: session.composition.runtime.getSessionSnapshot(session.composition.sessionId),
                            },
                        ]),
                    );
                    events.push("tui:concurrent-screens:captured");
                } else if (typed.type === "restartTui") {
                    restartedTuiHistory = [
                        restartedTuiHistory,
                        terminal.getScrollbackText(),
                        terminal.getScreenText(),
                    ].filter(Boolean).join("\n");
                    unsubscribe();
                    await composition?.dispose?.();
                    terminal = new VirtualTerminal(typed.terminal || scenario.terminal);
                    composition = await createInteractiveTuiComposition(null, {
                        browser: NO_OPEN_BROWSER_PORT,
                        terminal,
                        sessionStartMode: typed.sessionStartMode || scenario.sessionStartMode || "new",
                        initialAgentName: typed.initialAgentName || scenario.initialAgentName || "router",
                        initialAgentModel:
                            scenario.modelSetup === "none" || scenario.modelSetup === "provider-without-models"
                                ? undefined
                                : `${GOLDEN_FAUX_PROVIDER}/${GOLDEN_FAUX_MODEL}`,
                        configureUiAPI: configureScriptedUiAPI,
                    });
                    for (let attempt = 0; !terminal.started && attempt < 100; attempt += 1) {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    if (!terminal.started) throw new Error("Restarted terminal did not start.");
                    unsubscribe = composition.runtime.subscribeSessionEvents(composition.sessionId, handleRuntimeEvent);
                    events.push("tui:restarted");
                } else if (typed.type === "enter") terminal.pressEnter();
                else if (typed.type === "switchAgent") {
                    await runtime.switchAgent(composition.sessionId, { agentName: String(typed.agentName || "") });
                    events.push(`runtime:switch-agent:${typed.agentName || ""}`);
                } else if (typed.type === "escape") terminal.pressEscape();
                else if (typed.type === "ctrlC") {
                    terminal.pressCtrlC();
                    events.push("terminal:ctrl-c");
                } else if (typed.type === "resize") {
                    terminal.resize(typed.columns || 80, typed.rows || 24);
                    events.push(`terminal:resize:${typed.columns || 80}x${typed.rows || 24}`);
                } else if (typed.type === "assertTerminalSize") {
                    if (terminal.columns !== typed.columns || terminal.rows !== typed.rows) {
                        throw new Error(
                            `Expected terminal size ${typed.columns}x${typed.rows}, got ${terminal.columns}x${terminal.rows}`,
                        );
                    }
                    events.push(`terminal:size:${typed.columns}x${typed.rows}`);
                } else if (typed.type === "writeProjectFile") {
                    const path = join(Deno.cwd(), typed.path || "");
                    await Deno.mkdir(join(path, ".."), { recursive: true });
                    await Deno.writeTextFile(path, String(typed.text || ""));
                    events.push(`project:write:${typed.path || ""}`);
                } else if (typed.type === "deleteProjectFile") {
                    const path = join(Deno.cwd(), typed.path || "");
                    await Deno.remove(path);
                    events.push(`project:delete:${typed.path || ""}`);
                } else if (typed.type === "assertProjectFile") {
                    const path = join(Deno.cwd(), typed.path || "");
                    const exists = await Deno.stat(path).then(() => true).catch(() => false);
                    state.projectMutation = exists ? "mutated" : "clean";
                    if (exists !== Boolean(typed.exists)) {
                        throw new Error(`Project mutation assertion failed for ${typed.path || ""}: exists=${exists}`);
                    }
                    events.push("project:file-checked");
                } else if (typed.type === "captureProjectFileText") {
                    const key = String(typed.key || typed.path || "projectFileText");
                    const path = join(Deno.cwd(), typed.path || "");
                    state[key] = await Deno.readTextFile(path).catch(() => null);
                    events.push(`project:file-text:${typed.path || ""}`);
                } else if (typed.type === "assertProjectUnchanged") {
                    const changes = diffProjectSnapshots(projectSnapshotBefore, await snapshotProjectRoot(Deno.cwd()));
                    state.projectMutation = changes.length ? "mutated" : "clean";
                    state.projectMutationChanges = changes;
                    if (changes.length) throw new Error(`Project mutation assertion failed: ${changes.join(", ")}`);
                    events.push("project:mutation-checked");
                } else if (typed.type === "assertOnlyProjectChanges") {
                    const expected = new Set(Array.isArray(typed.paths) ? typed.paths : []);
                    const changes = diffProjectSnapshots(projectSnapshotBefore, await snapshotProjectRoot(Deno.cwd()));
                    state.projectMutation = changes.length ? "mutated" : "clean";
                    state.projectMutationChanges = changes;
                    const unexpected = changes.filter((change) =>
                        !expected.has(change.replace(/^(added|deleted|modified):/, ""))
                    );
                    if (unexpected.length || changes.length !== expected.size) {
                        throw new Error(
                            `Project mutation assertion failed: expected ${[...expected].join(", ")}; got ${
                                changes.join(", ")
                            }`,
                        );
                    }
                    events.push("project:mutation-policy:only-requested");
                } else if (typed.type === "assertWorkflowDurability") {
                    const registryRoot = join(
                        Deno.env.get("RUNWIELD_HOME") || join(Deno.env.get("HOME") || "", ".wld"),
                        "registry",
                    );
                    const registryEntries = [];
                    try {
                        for await (const entry of Deno.readDir(registryRoot)) registryEntries.push(entry.name);
                    } catch (error) {
                        if (!(error instanceof Deno.errors.NotFound)) throw error;
                    }
                    const { inspectWorktreeRegistry } = await import("../../../shared/worktree-registry.js");
                    const projectWorktreeRegistry = await inspectWorktreeRegistry(Deno.cwd());
                    const plan = await loadPlan(Deno.cwd(), "plan");
                    if (!plan) throw new Error("Expected the primary Plan locator for publication proof.");
                    const targetBranch = String(plan.attrs.targetBranch || plan.attrs.worktreeBaseBranch || "main");
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${targetBranch}.remote`],
                        Deno.cwd(),
                    ) || "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const deliveredHead = await runGoldenGit(
                        ["--git-dir", remotePath, "rev-parse", `refs/heads/${targetBranch}`],
                        Deno.cwd(),
                    );
                    const trackedFiles = await runGoldenGit(
                        ["--git-dir", remotePath, "ls-tree", "-r", "--name-only", deliveredHead],
                        Deno.cwd(),
                    );
                    const goldenFileExists = trackedFiles.split("\n").includes("golden-planned-change.txt");
                    const deliveryLog = goldenFileExists
                        ? await runGoldenGit(
                            [
                                "--git-dir",
                                remotePath,
                                "log",
                                "--format=%H",
                                deliveredHead,
                                "--",
                                "golden-planned-change.txt",
                            ],
                            Deno.cwd(),
                        )
                        : "";
                    const publishedPlanText = await runGoldenGit(
                        ["--git-dir", remotePath, "show", `${deliveredHead}:docs/plans/plan.md`],
                        Deno.cwd(),
                    );
                    const publishedPlan = parsePlanFrontMatter(publishedPlanText);
                    const publishedDeliveryEvidence = plan.attrs.deliveryEvidence;
                    const publishedFields = extractYaml(publishedPlanText).attrs;
                    for (const field of PLAN_RUNTIME_FIELDS) {
                        if (Object.hasOwn(publishedFields, field)) {
                            throw new Error(`Published Plan contains controller field ${field}`);
                        }
                    }
                    const validatedExecutionCommit = String(
                        publishedDeliveryEvidence?.mode === "worktree_merge"
                            ? publishedDeliveryEvidence.executionCommit
                            : "",
                    );
                    const executionCommitPublished = validatedExecutionCommit
                        ? await runGoldenGit(
                            [
                                "--git-dir",
                                remotePath,
                                "merge-base",
                                "--is-ancestor",
                                validatedExecutionCommit,
                                deliveredHead,
                            ],
                            Deno.cwd(),
                        ).then(() => true).catch(() => false)
                        : false;
                    const deliveryEvidence = goldenFileExists
                        ? await runGoldenGit(
                            ["--git-dir", remotePath, "show", `${deliveredHead}:golden-planned-change.txt`],
                            Deno.cwd(),
                        )
                        : "";
                    const branch = await runGoldenGit(["branch", "--show-current"], Deno.cwd());
                    const status = await runGoldenGit(["status", "--porcelain", "--untracked-files=all"], Deno.cwd());
                    const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
                    const editorUsable = snapshot?.busy === false;
                    state.editorUsable = editorUsable;
                    // The Plan's own status, captured before cleanup. Without it a
                    // stalled workflow leaves no way to tell which phase it died in.
                    const planStatus = String(publishedPlan.attrs.status || "");
                    state.workflowDurability = {
                        planStatus,
                        goldenFileExists,
                        registryEntries,
                        projectWorktreeRegistryEntries: projectWorktreeRegistry.entries,
                        branch,
                        status,
                        trackedFiles,
                        deliveryLog,
                        deliveryEvidence,
                        deliveredHead,
                        validatedExecutionCommit,
                        executionCommitPublished,
                        publishedPlanFields: publishedFields,
                        editorUsable,
                    };
                    if (!goldenFileExists) {
                        throw new Error("Expected golden-planned-change.txt on the upstream target.");
                    }
                    if (!trackedFiles.split("\n").includes("golden-planned-change.txt")) {
                        throw new Error(
                            "Expected golden-planned-change.txt to be tracked after Direct Delivery publication.",
                        );
                    }
                    if (!deliveryLog) {
                        throw new Error("Expected Git ancestry to include golden-planned-change.txt delivery commit.");
                    }
                    if (!validatedExecutionCommit) {
                        throw new Error(
                            "Expected durable delivery evidence to identify the validated execution commit.",
                        );
                    }
                    if (!executionCommitPublished) {
                        throw new Error(
                            `Expected delivered HEAD ${deliveredHead} to contain validated execution commit ${validatedExecutionCommit}.`,
                        );
                    }
                    if (branch !== "main" && branch !== "master") {
                        throw new Error(`Expected terminal on primary branch after delivery; got ${branch}`);
                    }
                    if (!deliveryEvidence.includes("golden")) {
                        throw new Error("Expected delivery evidence content in golden-planned-change.txt.");
                    }
                    if (registryEntries.length) {
                        throw new Error(`Expected clean worktree registry; got ${registryEntries.join(", ")}`);
                    }
                    if (projectWorktreeRegistry.entries.length) {
                        throw new Error(
                            `Expected clean project worktree registry; got ${
                                JSON.stringify(projectWorktreeRegistry.entries)
                            }`,
                        );
                    }
                    events.push("workflow:durability:terminal-ready");
                    if (!editorUsable) events.push("workflow:durability:terminal-busy");
                    events.push(`workflow:durability:branch:${branch}`);
                    events.push("workflow:durability:ancestry-checked");
                    events.push("workflow:durability:evidence-recorded");
                    events.push("workflow:durability:delivery-checked");
                    events.push("workflow:durability:registry-clean");
                } else if (typed.type === "runSlicerDecomposition") {
                    // Real decomposition. The Slicer agent turn, the
                    // slicer_finalize_decomposition tool, the Plan catalog lock and the
                    // composite Epic decomposition transaction all run for real; only
                    // the model's tool call comes from the script. Nothing here writes
                    // Plan files itself — a harness that materialized children would be
                    // testing its own mirror of decomposition instead of the product's.
                    const epicPlanName = String(typed.planName || "epic");
                    const epic = await loadPlan(Deno.cwd(), epicPlanName);
                    if (!epic) throw new Error(`Expected PROJECT Epic Plan ${epicPlanName} to exist.`);
                    if (epic.attrs.classification !== "PROJECT") {
                        throw new Error(
                            `Expected ${epicPlanName} to be a PROJECT Epic; got ${epic.attrs.classification}`,
                        );
                    }
                    events.push(`project:epic:status:${epic.attrs.status}`);
                    await writeHeartbeat();
                    const slicerResult = await composition.runtime.runSlicerAgent(composition.sessionId, {
                        planName: epicPlanName,
                        triageMeta: epic.attrs,
                    });
                    if (!slicerResult?.ok) {
                        throw new Error(`Slicer decomposition failed: ${slicerResult?.error || "unknown error"}`);
                    }
                    const materialized = (await findPlansByParent(Deno.cwd(), epicPlanName))
                        .filter((child) => child.attrs.classification === "PLANNED_CHANGE")
                        .sort((left, right) => Number(left.attrs.order || 0) - Number(right.attrs.order || 0));
                    if (materialized.length < 2) {
                        throw new Error(
                            `Expected the Slicer to materialize two child Plans; got ${
                                materialized.map((child) => child.name).join(", ") || "none"
                            }`,
                        );
                    }
                    state.projectChildren = materialized.map((child) => ({
                        name: child.name,
                        status: child.attrs.status,
                        classification: child.attrs.classification,
                        order: child.attrs.order,
                        parentPlan: child.attrs.parentPlan,
                    }));
                    events.push("project:slicer:materialized");
                    await writeHeartbeat();
                } else if (typed.type === "captureProjectDurability") {
                    // Observation only: every status read here was produced by the real
                    // lifecycle, so the assertions describe what the product did rather
                    // than what the harness arranged.
                    const epicPlanName = String(typed.planName || "epic");
                    const localParent = await loadPlan(Deno.cwd(), epicPlanName);
                    const localChildren = (await findPlansByParent(Deno.cwd(), epicPlanName))
                        .filter((child) => child.attrs.classification === "PLANNED_CHANGE")
                        .sort((left, right) => Number(left.attrs.order || 0) - Number(right.attrs.order || 0));
                    const branch = await runGoldenGit(["branch", "--show-current"], Deno.cwd());
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${branch}.remote`],
                        Deno.cwd(),
                    ).catch(() => "origin");
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd()).catch(() => "");
                    const primaryHead = remotePath
                        ? await runGoldenGit(
                            ["--git-dir", remotePath, "rev-parse", `refs/heads/${branch}`],
                            Deno.cwd(),
                        )
                        : "";
                    // Children of an Epic with its own branch are delivered there, not to the
                    // checked-out primary branch, so delivery evidence is read from that branch.
                    const epicBranch = typeof localParent?.attrs.targetBranch === "string"
                        ? localParent.attrs.targetBranch
                        : "";
                    const remoteHead = remotePath && epicBranch
                        ? await runGoldenGit(
                            ["--git-dir", remotePath, "rev-parse", `refs/heads/${epicBranch}`],
                            Deno.cwd(),
                        ).catch(() => primaryHead)
                        : primaryHead;
                    /** @param {string} name @param {string} head */
                    const loadRemotePlanAttrsAt = async (name, head) => {
                        if (!remotePath || !head) return null;
                        const markdown = await runGoldenGit(
                            ["--git-dir", remotePath, "show", `${head}:docs/plans/${name}.md`],
                            Deno.cwd(),
                        ).catch(() => "");
                        return markdown ? parsePlanFrontMatter(markdown).attrs : null;
                    };
                    /** @param {string} name */
                    const loadRemotePlanAttrs = (name) => loadRemotePlanAttrsAt(name, remoteHead);
                    state.projectPlans = {
                        parent: await loadRemotePlanAttrsAt(epicPlanName, primaryHead) || localParent?.attrs,
                        firstChild: localChildren[0]
                            ? await loadRemotePlanAttrs(localChildren[0].name) || localChildren[0].attrs
                            : undefined,
                        secondChild: localChildren[1]
                            ? await loadRemotePlanAttrs(localChildren[1].name) || localChildren[1].attrs
                            : undefined,
                    };
                    const registryPath = getWorktreeRegistryPath(getCwd());
                    const registryText = await Deno.readTextFile(registryPath).catch(() => "");
                    /** @type {import('../../../shared/worktree-registry.js').WorktreeRegistryEntry[]} */
                    const registryEntries = registryText ? (JSON.parse(registryText).entries || []) : [];
                    state.projectDurability = {
                        branch,
                        epicBranch,
                        primaryTrackedFiles: remotePath && primaryHead
                            ? await runGoldenGit(
                                ["--git-dir", remotePath, "ls-tree", "-r", "--name-only", primaryHead],
                                Deno.cwd(),
                            )
                            : "",
                        deliveryLog: remotePath && remoteHead
                            ? await runGoldenGit(
                                ["--git-dir", remotePath, "log", "--oneline", "-12", remoteHead],
                                Deno.cwd(),
                            )
                            : await runGoldenGit(["log", "--oneline", "-12"], Deno.cwd()),
                        trackedFiles: remotePath && remoteHead
                            ? await runGoldenGit(
                                ["--git-dir", remotePath, "ls-tree", "-r", "--name-only", remoteHead],
                                Deno.cwd(),
                            )
                            : await runGoldenGit(["ls-files"], Deno.cwd()),
                        status: await runGoldenGit(["status", "--porcelain"], Deno.cwd()),
                        liveRegistryEntries: registryEntries.filter((entry) =>
                            ["active", "execution_failed", "validation_failed", "merge_conflict"].includes(
                                String(entry.status || ""),
                            )
                        ).map((entry) => `${entry.planName || "?"}:${entry.status || "?"}`),
                        registryStatuses: registryEntries.map((entry) =>
                            `${entry.planName || "?"}:${entry.status || "?"}`
                        ),
                        registryEntryCount: registryEntries.length,
                    };
                    events.push("project:epic:evidence");
                    await writeHeartbeat();
                } else if (typed.type === "mergeReviewedEpicToFinalTarget") {
                    const projectRoot = getCwd();
                    const planName = String(typed.planName || "");
                    const plan = await loadPlan(projectRoot, planName);
                    const epicBranch = plan?.attrs.targetBranch;
                    const finalTarget = plan?.attrs.epicDeliveryTargetBranch;
                    const reviewedCommit = plan?.attrs.validatedCommit;
                    if (
                        plan?.attrs.status !== "reviewed" || !epicBranch || !finalTarget ||
                        !reviewedCommit || epicBranch === finalTarget
                    ) {
                        throw new Error("Expected a reviewed Epic with distinct recorded source and final target.");
                    }
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${finalTarget}.remote`],
                        projectRoot,
                    ).catch(() => "origin") || "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], projectRoot);
                    const mergeRoot = await Deno.makeTempDir({ prefix: "golden-user-epic-merge-" });
                    try {
                        await runGoldenGit(["clone", remotePath, mergeRoot], projectRoot);
                        await runGoldenGit(["checkout", "-B", finalTarget, `origin/${finalTarget}`], mergeRoot);
                        await runGoldenGit([
                            "-c",
                            "user.name=Golden User",
                            "-c",
                            "user.email=golden@example.test",
                            "merge",
                            "--no-ff",
                            `origin/${epicBranch}`,
                            "-m",
                            `Merge reviewed Epic ${planName}`,
                        ], mergeRoot);
                        await runGoldenGit(["push", "origin", `HEAD:refs/heads/${finalTarget}`], mergeRoot);
                        const deliveredCommit = await runGoldenGit(["rev-parse", "HEAD"], mergeRoot);
                        await runGoldenGit(["merge-base", "--is-ancestor", reviewedCommit, deliveredCommit], mergeRoot);
                        state.epicFinalDelivery = { reviewedCommit, deliveredCommit, epicBranch, finalTarget };
                        events.push(`project:epic:user-merged:${planName}:${finalTarget}`);
                    } finally {
                        await Deno.remove(mergeRoot, { recursive: true });
                    }
                    await writeHeartbeat();
                } else if (typed.type === "capturePublishedWorkRecords") {
                    const branch = await runGoldenGit(["branch", "--show-current"], Deno.cwd());
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${branch}.remote`],
                        Deno.cwd(),
                    ).catch(() => "origin");
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const remoteHead = await runGoldenGit(
                        ["--git-dir", remotePath, "rev-parse", `refs/heads/${branch}`],
                        Deno.cwd(),
                    );
                    const remoteTree = await runGoldenGit(
                        ["--git-dir", remotePath, "ls-tree", "-r", "--name-only", remoteHead],
                        Deno.cwd(),
                    );
                    const publishedNames = remoteTree.split("\n").filter((path) =>
                        path.startsWith("docs/work-records/") && path.endsWith(".md")
                    );
                    // Reloading an Epic after confirmed final delivery writes its record in
                    // the primary checkout, so capture that artifact as well as remote records.
                    const localNames = [];
                    try {
                        for await (const entry of Deno.readDir(join(Deno.cwd(), "docs", "work-records"))) {
                            if (entry.isFile && entry.name.endsWith(".md")) {
                                localNames.push(`docs/work-records/${entry.name}`);
                            }
                        }
                    } catch (error) {
                        if (!(error instanceof Deno.errors.NotFound)) throw error;
                    }
                    const status = publishedNames.length > 0 ? "published" : localNames.length > 0 ? "local" : "absent";
                    state.workRecord = {
                        status,
                        recordNames: publishedNames.length > 0 ? publishedNames : localNames.sort(),
                    };
                    events.push(`project:epic:work-record:${status}`);
                    await writeHeartbeat();
                } else if (typed.type === "deletePlanWorktreeBaseBranch") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot delete base branch for missing Plan ${planName}`);
                    const baseBranch = String(loaded.attrs.worktreeBaseBranch || "");
                    if (!baseBranch) throw new Error(`Plan ${planName} has no worktreeBaseBranch to delete`);
                    const replacementBranch = String(typed.replacementBranch || `golden-missing-target-${planName}`);
                    await runGoldenGit(["switch", "-c", replacementBranch], Deno.cwd());
                    await runGoldenGit(["branch", "-D", baseBranch], Deno.cwd());
                    events.push(`project:base-branch-deleted:${planName}:${baseBranch}`);
                    await writeHeartbeat();
                } else if (typed.type === "commitPlanWorktreeBaseBranchFile") {
                    const planName = String(typed.planName || "");
                    const path = String(typed.path || "");
                    if (!path) throw new Error("commitPlanWorktreeBaseBranchFile needs a path");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot edit base branch for missing Plan ${planName}`);
                    const baseBranch = String(loaded.attrs.worktreeBaseBranch || "");
                    if (!baseBranch) throw new Error(`Plan ${planName} has no worktreeBaseBranch to edit`);
                    await runGoldenGit(["switch", baseBranch], Deno.cwd());
                    await Deno.mkdir(dirname(join(Deno.cwd(), path)), { recursive: true });
                    await Deno.writeTextFile(join(Deno.cwd(), path), String(typed.text || ""));
                    await runGoldenGit(["add", path], Deno.cwd());
                    await runGoldenGit(
                        ["commit", "-m", String(typed.message || `seed ${planName} base conflict`)],
                        Deno.cwd(),
                    );
                    events.push(`project:base-branch-file-committed:${planName}:${baseBranch}:${path}`);
                    await writeHeartbeat();
                } else if (typed.type === "commitProjectPaths") {
                    const paths = Array.isArray(typed.paths) ? typed.paths.map(String).filter(Boolean) : [];
                    if (paths.length === 0) throw new Error("commitProjectPaths needs at least one path");
                    await runGoldenGit(["add", "--", ...paths], Deno.cwd());
                    await runGoldenGit(
                        ["commit", "-m", String(typed.message || "seed primary checkout changes")],
                        Deno.cwd(),
                    );
                    events.push(`project:paths-committed:${paths.join(",")}`);
                    await writeHeartbeat();
                } else if (typed.type === "appendProjectFile") {
                    const path = String(typed.path || "");
                    if (!path) throw new Error("appendProjectFile needs a path");
                    const absolutePath = join(Deno.cwd(), path);
                    const current = await Deno.readTextFile(absolutePath);
                    await Deno.writeTextFile(absolutePath, `${current}${String(typed.text || "")}`);
                    events.push(`project:file-appended:${path}`);
                    await writeHeartbeat();
                } else if (typed.type === "advancePlanRemoteTarget") {
                    const planName = String(typed.planName || "");
                    const path = String(typed.path || "");
                    if (!path) throw new Error("advancePlanRemoteTarget needs a path");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot advance target for missing Plan ${planName}`);
                    const targetBranch = String(loaded.attrs.targetBranch || loaded.attrs.worktreeBaseBranch || "main");
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${targetBranch}.remote`],
                        Deno.cwd(),
                    ) || "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const checkout = await Deno.makeTempDir({ prefix: "runwield-golden-remote-advance-" });
                    try {
                        await runGoldenGit(["clone", remotePath, checkout], Deno.cwd());
                        await runGoldenGit(["config", "user.email", "golden@example.test"], checkout);
                        await runGoldenGit(["config", "user.name", "Golden TUI"], checkout);
                        await runGoldenGit(["switch", targetBranch], checkout);
                        await Deno.mkdir(dirname(join(checkout, path)), { recursive: true });
                        await Deno.writeTextFile(join(checkout, path), String(typed.text || ""));
                        await runGoldenGit(["add", path], checkout);
                        await runGoldenGit(
                            ["commit", "-m", String(typed.message || "advance remote target")],
                            checkout,
                        );
                        await runGoldenGit(["push", "origin", targetBranch], checkout);
                    } finally {
                        await Deno.remove(checkout, { recursive: true }).catch(() => {});
                    }
                    events.push(`publication:remote-target-advanced:${planName}:${targetBranch}`);
                    await writeHeartbeat();
                } else if (typed.type === "setPlanRemotePushRejection") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot configure upstream for missing Plan ${planName}`);
                    const targetBranch = String(loaded.attrs.worktreeBaseBranch || "main");
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${targetBranch}.remote`],
                        Deno.cwd(),
                    ) || "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const hookPath = join(remotePath, "hooks", "pre-receive");
                    if (typed.enabled === false) {
                        await Deno.remove(hookPath).catch((error) => {
                            if (!(error instanceof Deno.errors.NotFound)) throw error;
                        });
                    } else {
                        await Deno.writeTextFile(
                            hookPath,
                            "#!/bin/sh\necho golden upstream rejection >&2\nexit 1\n",
                        );
                        await Deno.chmod(hookPath, 0o755);
                    }
                    events.push(`publication:remote-push-rejection:${typed.enabled === false ? "off" : "on"}`);
                    await writeHeartbeat();
                } else if (typed.type === "setPlanRemoteUnavailable") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot configure upstream for missing Plan ${planName}`);
                    const targetBranch = String(loaded.attrs.worktreeBaseBranch || "main");
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${targetBranch}.remote`],
                        Deno.cwd(),
                    ) || "origin";
                    const savedRemoteUrls = /** @type {Record<string, string>} */ (state.savedRemoteUrls ||= {});
                    if (typed.enabled === false) {
                        const savedUrl = savedRemoteUrls[remote];
                        if (typeof savedUrl !== "string" || !savedUrl) {
                            throw new Error(`No saved URL for temporarily unavailable remote ${remote}`);
                        }
                        await runGoldenGit(["remote", "set-url", remote, savedUrl], Deno.cwd());
                    } else {
                        const remoteUrl = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                        savedRemoteUrls[remote] = remoteUrl;
                        await runGoldenGit(
                            ["remote", "set-url", remote, `${remoteUrl}.temporarily-unavailable`],
                            Deno.cwd(),
                        );
                    }
                    events.push(`publication:remote-unavailable:${typed.enabled === false ? "off" : "on"}`);
                    await writeHeartbeat();
                } else if (typed.type === "removePlanRemote") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot remove remote for missing Plan ${planName}`);
                    const targetBranch = String(loaded.attrs.worktreeBaseBranch || "main");
                    const remote = await runGoldenGit(
                        ["config", "--get", `branch.${targetBranch}.remote`],
                        Deno.cwd(),
                    ).catch(() => "origin") || "origin";
                    await runGoldenGit(["branch", "--unset-upstream", targetBranch], Deno.cwd()).catch(() => {});
                    await runGoldenGit(["remote", "remove", remote], Deno.cwd());
                    events.push(`publication:remote-removed:${planName}:${targetBranch}`);
                    await writeHeartbeat();
                } else if (typed.type === "installPlanWorktreeFailingPreCommitHook") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot install hook for missing Plan ${planName}`);
                    const worktreePath = String(loaded.attrs.worktreePath || "");
                    if (!worktreePath) throw new Error(`Plan ${planName} has no worktreePath`);
                    const gitHookPath = (await runGoldenGit(
                        ["rev-parse", "--git-path", "hooks/pre-commit"],
                        worktreePath,
                    )).trim();
                    const hookPath = gitHookPath.startsWith("/") ? gitHookPath : join(worktreePath, gitHookPath);
                    await Deno.mkdir(dirname(hookPath), { recursive: true });
                    await Deno.writeTextFile(hookPath, "#!/bin/sh\necho golden publication failure >&2\nexit 1\n");
                    await Deno.chmod(hookPath, 0o755);
                    events.push(`project:failing-pre-commit-hook-installed:${planName}`);
                    await writeHeartbeat();
                } else if (typed.type === "seedActiveWorktree") {
                    const planName = String(typed.planName || "");
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot seed worktree for missing Plan ${planName}`);
                    const { createTestWorktreeAttempt } = await import("../../../shared/worktree-test-helpers.ts");
                    const { updateEntry } = await import("../../../shared/worktree-registry.js");
                    const { updatePlanFrontMatter } = await import("../../../plan-store.js");
                    const entry = await createTestWorktreeAttempt({
                        projectRoot: Deno.cwd(),
                        planName,
                        planId: String(loaded.attrs.planId || `golden:${planName}`),
                    });
                    let executionPlan = await loadPlan(entry.path, planName);
                    if (!executionPlan) {
                        const executionPlanPath = join(entry.path, "docs", "plans", `${planName}.md`);
                        await Deno.mkdir(dirname(executionPlanPath), { recursive: true });
                        await Deno.writeTextFile(executionPlanPath, loaded.markdown);
                        executionPlan = await loadPlan(entry.path, planName);
                    }
                    if (!executionPlan) throw new Error(`Could not seed execution Plan: ${planName}`);
                    if (Array.isArray(typed.files)) {
                        for (const file of typed.files) {
                            if (!isObject(file) || typeof file.path !== "string") continue;
                            await Deno.writeTextFile(join(entry.path, file.path), String(file.text || ""));
                        }
                        await runGoldenGit(["add", "."], entry.path);
                        await runGoldenGit(["commit", "-m", `seed ${planName} worktree diff`], entry.path);
                    }
                    const legacyStrandedPublication = typed.legacyStrandedPublication === true;
                    const executionCommit = legacyStrandedPublication
                        ? await runGoldenGit(["rev-parse", "HEAD"], entry.path)
                        : "";
                    const status = legacyStrandedPublication
                        ? "verified"
                        : typeof typed.status === "string"
                        ? typed.status
                        : "in_progress";
                    const rememberedValidationPhase = ["mechanical", "semantic", "delivery"].includes(
                            typed.rememberedValidationPhase,
                        )
                        ? typed.rememberedValidationPhase
                        : null;
                    const rememberedStatus = rememberedValidationPhase === "mechanical"
                        ? "implemented"
                        : rememberedValidationPhase === "semantic"
                        ? "validated_ci"
                        : "reviewed";
                    const registryStatus = legacyStrandedPublication
                        ? "completed"
                        : typed.registryStatus === "validation_failed"
                        ? "validation_failed"
                        : typed.registryStatus === "completed" || status === "implemented"
                        ? "completed"
                        : "active";
                    if (registryStatus !== "active") {
                        await updateEntry(Deno.cwd(), entry.id, { status: registryStatus });
                    }
                    const attemptMetadata = legacyStrandedPublication ? {} : {
                        worktreeId: entry.id,
                        worktreePath: entry.path,
                        worktreeBranch: entry.branch,
                        worktreeBaseBranch: entry.baseBranch,
                        worktreeStatus: registryStatus,
                    };
                    const seededPlanUpdates = {
                        status,
                        ...attemptMetadata,
                        ...(legacyStrandedPublication
                            ? {
                                executionMode: "worktree",
                                verifiedAt: new Date().toISOString(),
                                deliveryEvidence: {
                                    version: 1,
                                    mode: "worktree_merge",
                                    executionCommit,
                                    targetBranch: entry.baseBranch,
                                    targetHeadBeforeMerge: await runGoldenGit(
                                        ["rev-parse", entry.baseBranch],
                                        Deno.cwd(),
                                    ),
                                },
                            }
                            : {}),
                        ...(status === "validated_ci" || status === "reviewed" ? { validationSemanticRounds: 0 } : {}),
                        ...(status === "implemented" ? { validationCiAttempts: 0 } : {}),
                        ...(rememberedValidationPhase
                            ? {
                                validationCheckpoint: {
                                    version: 1,
                                    attemptId: entry.id,
                                    generation: `golden-${planName}-remembered-phase`,
                                    expectedStatus: rememberedStatus,
                                    nextPhase: rememberedValidationPhase,
                                    state: "paused",
                                    updatedAt: new Date().toISOString(),
                                },
                            }
                            : {}),
                        ...(isObject(typed.attrs) ? typed.attrs : {}),
                    };
                    await updatePlanFrontMatter(
                        Deno.cwd(),
                        planName,
                        seededPlanUpdates,
                        loaded.attrs,
                        { expectedRevision: loaded.revision },
                    );
                    await updatePlanFrontMatter(
                        entry.path,
                        planName,
                        seededPlanUpdates,
                        executionPlan.attrs,
                        { expectedRevision: executionPlan.revision },
                    );
                    if (legacyStrandedPublication) {
                        const planPath = `docs/plans/${planName}.md`;
                        await runGoldenGit(["add", planPath], Deno.cwd());
                        await runGoldenGit(
                            ["commit", "-m", `legacy metadata-only publication for ${planName}`],
                            Deno.cwd(),
                        );
                        await runGoldenGit(["push", "origin", entry.baseBranch], Deno.cwd());
                    }
                    events.push(`project:worktree-seeded:${planName}`);
                    events.push(`project:worktree-seeded:${planName}:${status}`);
                    await writeHeartbeat();
                } else if (typed.type === "setPrimaryPlanStatus") {
                    const planName = String(typed.planName || "");
                    const rawStatus = String(typed.status || "");
                    if (
                        !PLAN_STATUSES.includes(
                            /** @type {import('../../../shared/workflow/plan-lifecycle.js').PlanStatus} */ (rawStatus),
                        )
                    ) {
                        throw new Error(`Cannot set invalid primary Plan status: ${rawStatus}`);
                    }
                    const status = /** @type {import('../../../shared/workflow/plan-lifecycle.js').PlanStatus} */ (
                        rawStatus
                    );
                    const loaded = await loadPlan(Deno.cwd(), planName);
                    if (!loaded) throw new Error(`Cannot update missing primary Plan ${planName}`);
                    const { updatePlanFrontMatter } = await import("../../../plan-store.js");
                    const clearWorktreeEvidence = typed.clearWorktreeEvidence === true;
                    const clearPrimaryWorktreeEvidence = clearWorktreeEvidence ||
                        typed.clearPrimaryWorktreeEvidence === true;
                    await updatePlanFrontMatter(
                        Deno.cwd(),
                        planName,
                        {
                            status,
                            ...(clearPrimaryWorktreeEvidence
                                ? {
                                    executionMode: null,
                                    executionBaselineTree: null,
                                    worktreeId: null,
                                    worktreePath: null,
                                    worktreeBranch: null,
                                    worktreeBaseBranch: null,
                                    worktreeStatus: null,
                                }
                                : {}),
                        },
                        loaded.attrs,
                        { expectedRevision: loaded.revision },
                    );
                    if (clearWorktreeEvidence && loaded.attrs.worktreeId) {
                        const { pruneEntry } = await import("../../../shared/worktree-registry.js");
                        await pruneEntry(Deno.cwd(), loaded.attrs.worktreeId);
                    }
                    events.push(`project:primary-plan-status:${planName}:${status}`);
                    await writeHeartbeat();
                } else if (typed.type === "captureGitState") {
                    const paths = Array.isArray(typed.paths) ? typed.paths.map(String) : [];
                    const pathArgs = paths.length ? ["--", ...paths] : [];
                    state.gitState = {
                        branch: await runGoldenGit(["branch", "--show-current"], Deno.cwd()),
                        status: await runGoldenGit(["status", "--porcelain", ...pathArgs], Deno.cwd()),
                        trackedFiles: paths.length
                            ? await runGoldenGit(["ls-files", ...paths], Deno.cwd())
                            : await runGoldenGit(["ls-files"], Deno.cwd()),
                        head: await runGoldenGit(["rev-parse", "HEAD"], Deno.cwd()),
                    };
                    events.push("project:git-state:captured");
                    await writeHeartbeat();
                } else if (typed.type === "captureProjectState") {
                    const planNames = Array.isArray(typed.planNames) ? typed.planNames.map(String) : [];
                    const primaryPlanNames = new Set(
                        Array.isArray(typed.primaryPlanNames) ? typed.primaryPlanNames.map(String) : [],
                    );
                    const { inspectWorktreeRegistry } = await import("../../../shared/worktree-registry.js");
                    const registry = await inspectWorktreeRegistry(Deno.cwd());
                    const branch = await runGoldenGit(["branch", "--show-current"], Deno.cwd()).catch(() => "");
                    const remote = branch
                        ? await runGoldenGit(["config", "--get", `branch.${branch}.remote`], Deno.cwd()).catch(
                            () => "origin",
                        )
                        : "";
                    const remotePath = remote
                        ? await runGoldenGit(["remote", "get-url", remote], Deno.cwd()).catch(() => "")
                        : "";
                    const plans = [];
                    for (const planName of planNames) {
                        const primaryPlan = primaryPlanNames.has(planName) ? await loadPlan(getCwd(), planName) : null;
                        const entry = registry.entries.find((candidate) => candidate.planName === planName);
                        const executionPlan = entry?.path
                            ? await loadPlan(entry.path, planName).catch(() => null)
                            : null;
                        const remotePlanText = !executionPlan && remotePath && branch
                            ? await runGoldenGit(
                                [
                                    "--git-dir",
                                    remotePath,
                                    "show",
                                    `refs/heads/${branch}:docs/plans/${planName}.md`,
                                ],
                                Deno.cwd(),
                            ).catch(() => "")
                            : "";
                        const localPlan = !executionPlan && !remotePlanText
                            ? await loadPlan(Deno.cwd(), planName).catch(() => null)
                            : null;
                        const attrs = primaryPlan?.attrs || executionPlan?.attrs ||
                            (remotePlanText ? parsePlanFrontMatter(remotePlanText).attrs : localPlan?.attrs) || null;
                        const controller = attrs
                            ? await readControllerRecord(getCwd(), { planName, planId: attrs.planId })
                            : null;
                        plans.push({ name: planName, attrs, controllerState: controller?.state || null });
                    }
                    const { listWorkRecords } = await import("../../../shared/work-records/store.js");
                    const records = await listWorkRecords(Deno.cwd(), { createDir: false }).catch(() => []);
                    const capturedProjectState = {
                        runtimeSnapshot: composition.runtime.getSessionSnapshot(composition.sessionId),
                        plans,
                        registryEntries: registry.entries,
                        nonTerminalRegistryEntries: registry.entries.filter((entry) =>
                            ["active", "execution_failed", "validation_failed", "merge_conflict"].includes(
                                String(entry.status || ""),
                            )
                        ),
                        registryIntegrityIssues: registry.integrityIssues,
                        workRecordNames: records.map((record) => record.relativePath),
                    };
                    state.projectState = capturedProjectState;
                    if (typed.key) state[String(typed.key)] = capturedProjectState;
                    events.push("project:state:captured");
                    await writeHeartbeat();
                } else if (typed.type === "assertNoPlanFile") {
                    const plansRoot = join(Deno.cwd(), "docs", "plans");
                    const planPath = join(plansRoot, `${String(typed.planName || "")}.md`);
                    const exists = await Deno.stat(planPath).then(() => true).catch(() => false);
                    if (exists) throw new Error(`Expected no Plan file at ${planPath}`);
                    /** @type {string[]} */
                    const planFiles = [];
                    /** @type {(directory: string) => Promise<void>} */
                    const collectPlanFiles = async (directory) => {
                        try {
                            for await (const entry of Deno.readDir(directory)) {
                                const child = join(directory, entry.name);
                                if (entry.isDirectory) await collectPlanFiles(child);
                                else if (entry.isFile && entry.name.endsWith(".md")) {
                                    planFiles.push(relative(plansRoot, child));
                                }
                            }
                        } catch (error) {
                            if (!(error instanceof Deno.errors.NotFound)) throw error;
                        }
                    };
                    await collectPlanFiles(plansRoot);
                    if (planFiles.length) {
                        throw new Error(`Expected QUICK_FIX to create no Plan files; got ${planFiles.join(", ")}`);
                    }
                    state.planFiles = planFiles;
                    events.push("project:plan-file-absent");
                } else if (typed.type === "uiPresentationState") {
                    composition.uiAPI.setBusy?.(true);
                    events.push("ui:spinner:busy");
                    composition.uiAPI.setManagedSyncStatus?.({ status: "stale", owningSurfaceKind: "tui" });
                    events.push("ui:managed-sync:stale");
                    composition.uiAPI.appendQueuedMessage?.("golden-queued", "Queued steering message");
                    events.push("ui:queued-steering:add");
                    composition.uiAPI.appendImage?.(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        "image/png",
                    );
                    events.push("ui:image:png");
                    // Capture while the blocks are still up. Every one of them is torn
                    // down a few lines below, so the run's final screen cannot show
                    // them — which is how these capabilities came to be "covered" by
                    // events that never proved anything reached a terminal.
                    //
                    // One flush is not enough: `requestRender` is scheduled, so a
                    // single macrotask yield captures the screen from before the blocks
                    // were drawn. Wait for the screen to actually change.
                    for (let attempt = 0; attempt < 50; attempt += 1) {
                        await terminal.flush();
                        const screen = terminal.getScreenText();
                        if (
                            /Routing\.\.\.|Figuring out what you need\.\.\./.test(screen) &&
                            screen.includes("Sync degraded — refresh required") &&
                            screen.includes("Steering: Queued steering message") &&
                            (terminal.writes.includes("iVBORw0KGgoAAA") ||
                                terminal.getScrollbackText().includes("[Image: [image/png]"))
                        ) break;
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    const presentationScreen = terminal.getScreenText();
                    state.presentationScreen = presentationScreen;
                    // A block appended to the message list scrolls above the viewport
                    // as soon as anything follows it, so the proof includes scrollback.
                    const presentationScrollback = terminal.getScrollbackText();
                    state.presentationScrollback = presentationScrollback;
                    // Capable terminals receive image bytes. Headless/unsupported
                    // terminals receive pi-tui's visible image fallback instead. Both
                    // are real rendered outcomes, unlike merely recording the API call.
                    const presentationWrites = String(
                        /** @type {{ writes?: string }} */ (terminal).writes || "",
                    );
                    state.presentationImageRendered = presentationWrites.includes("iVBORw0KGgoAAA") ||
                        presentationScreen.includes("[Image: [image/png]") ||
                        presentationScrollback.includes("[Image: [image/png]");
                    composition.uiAPI.removeQueuedMessage?.("golden-queued");
                    events.push("ui:queued-steering:remove");
                    composition.uiAPI.setBusy?.(false);
                    events.push("ui:spinner:idle");
                    state.presentationStateExercised = true;
                } else if (typed.type === "promptFocusRoundTrip") {
                    const prompt = composition.uiAPI.promptText?.("Golden prompt focus", { allowEmpty: true });
                    await terminal.flush();
                    events.push("ui:prompt-focus:active");
                    composition.uiAPI.abortActivePrompt?.();
                    await prompt;
                    await terminal.flush();
                    events.push("ui:prompt-focus:restored");
                    state.promptFocusRestored = true;
                } else if (typed.type === "slashAutocomplete") {
                    terminal.typeText("/he");
                    terminal.input("\t");
                    events.push("terminal:autocomplete:/he");
                } else if (typed.type === "runtimeInteraction") {
                    const request =
                        /** @type {import('../../../shared/session/session-runtime-interactions.js').RuntimeInteractionRequest} */ (typed
                            .request || {});
                    activeScriptedInteractionType = request.type === "approval"
                        ? "approval"
                        : request.type === "text"
                        ? "text"
                        : "select";
                    try {
                        const response = await composition.runtime.requestInteraction(composition.sessionId, request);
                        state.lastInteraction = response;
                        events.push(`interaction:${request.type}:${response.outcome}`);
                        if (typed.expectedOutcome && response.outcome !== typed.expectedOutcome) {
                            throw new Error(
                                `Runtime interaction expected ${typed.expectedOutcome}, got ${response.outcome}`,
                            );
                        }
                    } finally {
                        activeScriptedInteractionType = null;
                    }
                } else if (typed.type === "sleep") {
                    await new Promise((resolve) => setTimeout(resolve, typed.ms || 1000));
                } else if (typed.type === "waitForEvent") {
                    const expected = String(typed.event || "");
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
                    const startedAt = Date.now();
                    while (!events.includes(expected)) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(`Timed out waiting for event: ${expected}`);
                        }
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                } else if (typed.type === "waitForEventCount") {
                    const expected = String(typed.event || "");
                    const expectedCount = Number(typed.count || 1);
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
                    const startedAt = Date.now();
                    while (events.filter((event) => event === expected).length < expectedCount) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for ${expectedCount} occurrences of event: ${expected}; got ${
                                    events.filter((event) => event === expected).length
                                }`,
                            );
                        }
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                } else if (typed.type === "waitForPlanStatus") {
                    const planName = String(typed.planName || "");
                    const expectedStatuses = new Set((Array.isArray(typed.statuses) ? typed.statuses : []).map(String));
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || 3000;
                    const planPath = `docs/plans/${planName}.md`;
                    const localBranch = await runGoldenGit(["branch", "--show-current"], Deno.cwd()).catch(() => "");
                    const remoteName = localBranch
                        ? await runGoldenGit(["config", "--get", `branch.${localBranch}.remote`], Deno.cwd()).catch(
                            () => "origin",
                        )
                        : "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remoteName], Deno.cwd()).catch(
                        () => "",
                    );
                    const startedAt = Date.now();
                    let latestStatus = "";
                    let matchedStatus = false;
                    while (!matchedStatus) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for Plan ${planName} status ${
                                    [...expectedStatuses].join(" or ")
                                }; latest=${latestStatus || "unreadable"}`,
                            );
                        }
                        const localPlan = await loadPlan(Deno.cwd(), planName).catch(() => null);
                        const registry = await (await import("../../../shared/worktree-registry.js"))
                            .inspectWorktreeRegistry(Deno.cwd());
                        const entry = registry.entries.find((candidate) => candidate.planName === planName);
                        const executionPlan = entry?.path
                            ? await loadPlan(entry.path, planName).catch(() => null)
                            : null;
                        const targetBranch = entry?.baseBranch || localBranch;
                        const remotePlanText = remotePath && targetBranch
                            ? await runGoldenGit(
                                ["--git-dir", remotePath, "show", `refs/heads/${targetBranch}:${planPath}`],
                                Deno.cwd(),
                            ).catch(() => "")
                            : "";
                        const candidateAttrs = [
                            executionPlan?.attrs,
                            remotePlanText ? parsePlanFrontMatter(remotePlanText).attrs : null,
                            localPlan?.attrs,
                        ].filter((attrs) => attrs != null);
                        const matching = candidateAttrs.find((attrs) =>
                            expectedStatuses.has(String(attrs.status || "")) &&
                            (!typed.validationPhase || attrs.validationPhase === typed.validationPhase) &&
                            (!typed.workRecordStatus || attrs.workRecord?.status === typed.workRecordStatus)
                        );
                        matchedStatus = Boolean(matching);
                        latestStatus = matching ? String(matching.status) : candidateAttrs.map((attrs) =>
                            [
                                attrs.status,
                                typed.validationPhase ? attrs.validationPhase : "",
                                typed.workRecordStatus ? attrs.workRecord?.status : "",
                            ].filter(Boolean).join(":")
                        ).join("/");
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    events.push(`project:plan-status:${planName}:${latestStatus}`);
                } else if (typed.type === "waitForExecutionPlanStatus") {
                    const planName = String(typed.planName || "");
                    const expectedStatuses = new Set((Array.isArray(typed.statuses) ? typed.statuses : []).map(String));
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || 3000;
                    const startedAt = Date.now();
                    let latestStatus = "";
                    while (!expectedStatuses.has(latestStatus)) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for execution Plan ${planName} status ${
                                    [...expectedStatuses].join(" or ")
                                }; latest=${latestStatus || "unreadable"}`,
                            );
                        }
                        const registry = await (await import("../../../shared/worktree-registry.js"))
                            .inspectWorktreeRegistry(Deno.cwd());
                        const entry = registry.entries.find((candidate) => candidate.planName === planName);
                        const executionPlan = entry?.path
                            ? await loadPlan(entry.path, planName).catch(() => null)
                            : null;
                        latestStatus = String(executionPlan?.attrs.status || "");
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    events.push(`project:execution-plan-status:${planName}:${latestStatus}`);
                } else if (typed.type === "captureExecutionPlanState") {
                    const planName = String(typed.planName || "");
                    const registry = await (await import("../../../shared/worktree-registry.js"))
                        .inspectWorktreeRegistry(Deno.cwd());
                    const entry = registry.entries.find((candidate) => candidate.planName === planName);
                    const executionPlan = entry?.path ? await loadPlan(entry.path, planName).catch(() => null) : null;
                    state.executionPlan = {
                        attrs: executionPlan?.attrs || null,
                        registryEntry: entry || null,
                    };
                    events.push(`project:execution-plan-state:${planName}`);
                } else if (typed.type === "capturePublicationBaseline") {
                    const paths = Array.isArray(typed.paths) ? typed.paths.map(String) : [];
                    /** @type {Record<string, string | null>} */
                    const files = {};
                    for (const path of paths) {
                        files[path] = await Deno.readTextFile(join(Deno.cwd(), path)).catch(() => null);
                    }
                    const executionWorktrees = (await runGoldenGit(["worktree", "list", "--porcelain"], getCwd()))
                        .split("\n")
                        .filter((line) => line.startsWith("worktree "))
                        .slice(1)
                        .map((line) => line.slice("worktree ".length));
                    state.publicationBaseline = {
                        executionWorktrees,
                        executionCommits: await Promise.all(
                            executionWorktrees.map((path) => runGoldenGit(["rev-parse", "HEAD"], path)),
                        ),
                        head: await runGoldenGit(["rev-parse", "HEAD"], Deno.cwd()),
                        branch: await runGoldenGit(["branch", "--show-current"], Deno.cwd()),
                        status: await runGoldenGit(["status", "--porcelain", "--untracked-files=all"], Deno.cwd()),
                        files,
                    };
                    events.push("publication:primary-baseline-captured");
                } else if (typed.type === "waitForWorktreeRegistryStatus") {
                    const planName = String(typed.planName || "");
                    const expectedStatuses = new Set((Array.isArray(typed.statuses) ? typed.statuses : []).map(String));
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || 3000;
                    const startedAt = Date.now();
                    let latestStatus = "";
                    while (!expectedStatuses.has(latestStatus)) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for ${planName} worktree status ${
                                    [...expectedStatuses].join(" or ")
                                }; latest=${latestStatus || "missing"}`,
                            );
                        }
                        const registry = await (await import("../../../shared/worktree-registry.js"))
                            .inspectWorktreeRegistry(Deno.cwd());
                        const entry = registry.entries.find((candidate) => candidate.planName === planName);
                        latestStatus = entry ? String(entry.status || "") : "absent";
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    events.push(`publication:registry-status:${planName}:${latestStatus}`);
                } else if (typed.type === "capturePendingPublicationState") {
                    const planName = String(typed.planName || "");
                    const registry = await (await import("../../../shared/worktree-registry.js"))
                        .inspectWorktreeRegistry(Deno.cwd());
                    const entry = registry.entries.find((candidate) => candidate.planName === planName);
                    if (!entry) throw new Error(`Expected pending publication entry for ${planName}`);
                    const executionPlan = await loadPlan(entry.path, planName);
                    const branchExists = await runGoldenGit(
                        ["show-ref", "--verify", `refs/heads/${entry.branch}`],
                        Deno.cwd(),
                    ).then(() => true).catch(() => false);
                    const baselineFiles = state.publicationBaseline?.files || {};
                    /** @type {Record<string, string | null>} */
                    const currentFiles = {};
                    for (const path of Object.keys(baselineFiles)) {
                        currentFiles[path] = await Deno.readTextFile(join(Deno.cwd(), path)).catch(() => null);
                    }
                    state.pendingPublication = {
                        registryStatus: entry.status,
                        executionPlanStatus: executionPlan?.attrs.status,
                        worktreeExists: await Deno.stat(entry.path).then(() => true).catch(() => false),
                        branchExists,
                        primaryHead: await runGoldenGit(["rev-parse", "HEAD"], Deno.cwd()),
                        primaryStatus: await runGoldenGit(
                            ["status", "--porcelain", "--untracked-files=all"],
                            Deno.cwd(),
                        ),
                        primaryFiles: currentFiles,
                    };
                    events.push(`publication:pending-state-captured:${planName}`);
                } else if (typed.type === "waitForRemotePlanStatus") {
                    const planName = String(typed.planName || "");
                    const expectedStatuses = new Set((Array.isArray(typed.statuses) ? typed.statuses : []).map(String));
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || 3000;
                    const primaryPlan = await loadPlan(Deno.cwd(), planName);
                    const targetBranch = String(
                        primaryPlan?.attrs.targetBranch || primaryPlan?.attrs.worktreeBaseBranch || "main",
                    );
                    const remote =
                        await runGoldenGit(["config", "--get", `branch.${targetBranch}.remote`], Deno.cwd()) ||
                        "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const planPath = `docs/plans/${planName}.md`;
                    const startedAt = Date.now();
                    let latestStatus = "";
                    while (!expectedStatuses.has(latestStatus)) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for published Plan ${planName} status ${
                                    [...expectedStatuses].join(" or ")
                                }; latest=${latestStatus || "unreadable"}`,
                            );
                        }
                        const remoteText = await runGoldenGit(
                            ["--git-dir", remotePath, "show", `refs/heads/${targetBranch}:${planPath}`],
                            Deno.cwd(),
                        ).catch(() => "");
                        latestStatus = remoteText ? String(parsePlanFrontMatter(remoteText).attrs.status || "") : "";
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    events.push(`publication:remote-plan-status:${planName}:${latestStatus}`);
                } else if (typed.type === "capturePublicationState") {
                    const planName = String(typed.planName || "");
                    const deliveredPath = String(typed.deliveredPath || "");
                    const primaryPlan = await loadPlan(Deno.cwd(), planName);
                    const targetBranch = String(
                        primaryPlan?.attrs.targetBranch || primaryPlan?.attrs.worktreeBaseBranch || "main",
                    );
                    const remote =
                        await runGoldenGit(["config", "--get", `branch.${targetBranch}.remote`], Deno.cwd()) ||
                        "origin";
                    const remotePath = await runGoldenGit(["remote", "get-url", remote], Deno.cwd());
                    const remoteHead = await runGoldenGit(
                        ["--git-dir", remotePath, "rev-parse", `refs/heads/${targetBranch}`],
                        Deno.cwd(),
                    );
                    const remotePlanText = await runGoldenGit(
                        ["--git-dir", remotePath, "show", `${remoteHead}:docs/plans/${planName}.md`],
                        Deno.cwd(),
                    );
                    const remoteTree = await runGoldenGit(
                        ["--git-dir", remotePath, "ls-tree", "-r", "--name-only", remoteHead],
                        Deno.cwd(),
                    );
                    const registry = await (await import("../../../shared/worktree-registry.js"))
                        .inspectWorktreeRegistry(Deno.cwd());
                    const baselineFiles = state.publicationBaseline?.files || {};
                    /** @type {Record<string, string | null>} */
                    const currentFiles = {};
                    for (const path of Object.keys(baselineFiles)) {
                        currentFiles[path] = await Deno.readTextFile(join(Deno.cwd(), path)).catch(() => null);
                    }
                    // Query Git even after the registry entry has been removed. An
                    // absent pointer is not proof that the branch was deleted.
                    const branchExists = Boolean(
                        await runGoldenGit(
                            ["for-each-ref", "--format=%(refname)", "refs/heads/worktree/"],
                            getCwd(),
                        ),
                    );
                    const remotePlanAttrs = parsePlanFrontMatter(remotePlanText).attrs;
                    const capturedPublication = {
                        validatedCommitPublished: Boolean(remotePlanAttrs.validatedCommit) && await runGoldenGit(
                            [
                                "--git-dir",
                                remotePath,
                                "merge-base",
                                "--is-ancestor",
                                remotePlanAttrs.validatedCommit || "",
                                remoteHead,
                            ],
                            getCwd(),
                        ).then(() => true).catch(() => false),
                        executionCommitsPublished: await Promise.all(
                            (state.publicationBaseline?.executionCommits || []).map((commit) =>
                                runGoldenGit(
                                    ["--git-dir", remotePath, "merge-base", "--is-ancestor", commit, remoteHead],
                                    getCwd(),
                                ).then(() => true).catch(() => false)
                            ),
                        ),
                        registeredWorktrees: (await runGoldenGit(["worktree", "list", "--porcelain"], getCwd()))
                            .split("\n")
                            .filter((line) => line.startsWith("worktree ")),
                        remainingExecutionWorktrees: (await Promise.all(
                            (state.publicationBaseline?.executionWorktrees || []).map(async (path) =>
                                await Deno.stat(path).then(() => path).catch((error) => {
                                    if (error instanceof Deno.errors.NotFound) return null;
                                    throw error;
                                })
                            ),
                        )).filter((path) => path !== null),
                        primaryHead: await runGoldenGit(["rev-parse", "HEAD"], Deno.cwd()),
                        primaryBranch: await runGoldenGit(["branch", "--show-current"], Deno.cwd()),
                        primaryStatus: await runGoldenGit(
                            ["status", "--porcelain", "--untracked-files=all"],
                            Deno.cwd(),
                        ),
                        primaryFiles: currentFiles,
                        remoteHead,
                        remotePlanStatus: parsePlanFrontMatter(remotePlanText).attrs.status,
                        remotePlanAttrs,
                        remotePlanFields: Object.keys(extractYaml(remotePlanText).attrs),
                        controllerState:
                            (await readControllerRecord(getCwd(), { planName, planId: primaryPlan?.attrs.planId }))
                                ?.state,
                        remoteTree,
                        deliveredText: deliveredPath
                            ? await runGoldenGit(
                                ["--git-dir", remotePath, "show", `${remoteHead}:${deliveredPath}`],
                                Deno.cwd(),
                            ).catch(() => "")
                            : "",
                        registryEntries: registry.entries,
                        worktreeBranchExists: branchExists,
                    };
                    state.publication = capturedPublication;
                    if (typed.key) state[String(typed.key)] = capturedPublication;
                    events.push(`publication:state-captured:${planName}`);
                } else if (typed.type === "captureLocalPublicationState") {
                    const planName = String(typed.planName || "");
                    const deliveredPath = String(typed.deliveredPath || "");
                    const plan = await loadPlan(Deno.cwd(), planName);
                    const registry = await (await import("../../../shared/worktree-registry.js"))
                        .inspectWorktreeRegistry(Deno.cwd());
                    const baselineFiles = state.publicationBaseline?.files || {};
                    /** @type {Record<string, string | null>} */
                    const currentFiles = {};
                    for (const path of Object.keys(baselineFiles)) {
                        currentFiles[path] = await Deno.readTextFile(join(Deno.cwd(), path)).catch(() => null);
                    }
                    state.localPublication = {
                        head: await runGoldenGit(["rev-parse", "HEAD"], Deno.cwd()),
                        branch: await runGoldenGit(["branch", "--show-current"], Deno.cwd()),
                        status: await runGoldenGit(["status", "--porcelain", "--untracked-files=all"], Deno.cwd()),
                        files: currentFiles,
                        planStatus: plan?.attrs.status,
                        deliveredText: deliveredPath
                            ? await Deno.readTextFile(join(Deno.cwd(), deliveredPath)).catch(() => "")
                            : "",
                        registryEntries: registry.entries,
                    };
                    events.push(`publication:local-state-captured:${planName}`);
                } else if (typed.type === "waitForPlanAbsent") {
                    const planName = String(typed.planName || "");
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || 3000;
                    const startedAt = Date.now();
                    let latestAttrs = null;
                    while (true) {
                        const loaded = await loadPlan(Deno.cwd(), planName).catch(() => null);
                        latestAttrs = loaded?.attrs || null;
                        if (!latestAttrs) break;
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for Plan ${planName} to leave active storage; latest=${
                                    JSON.stringify(latestAttrs)
                                }`,
                            );
                        }
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                    events.push(`project:plan-absent:${planName}`);
                } else if (typed.type === "waitForIdle") {
                    await composition.waitForIdle(typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS);
                } else if (typed.type === "waitForScriptedInteractions") {
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
                    const expectedRemaining = Number(typed.remaining || 0);
                    const startedAt = Date.now();
                    while ((interactionSurface?.interactions.length || 0) > expectedRemaining) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(
                                `Timed out waiting for scripted Runtime interactions; remaining=${
                                    interactionSurface?.interactions.length || 0
                                }`,
                            );
                        }
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                } else if (typed.type === "setNextModelResponse") {
                    const responseText = String(typed.text || "");
                    const nextAgent = composition?.runtime.getSessionSnapshot(composition.sessionId)?.activeAgent ||
                        "guide";
                    fauxProvider?.setResponses([() =>
                        createFauxMessageForTurn({
                            id: "golden-next-model-response",
                            agent: nextAgent,
                            phase: "inquiry",
                            text: responseText,
                        })]);
                } else if (typed.type === "waitForScreen") {
                    const expected = String(typed.text || "");
                    const timeoutMs = typed.timeoutMs || scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
                    const startedAt = Date.now();
                    while (!terminal.getScreenText().includes(expected)) {
                        if (Date.now() - startedAt > timeoutMs) {
                            throw new Error(`Timed out waiting for screen marker: ${JSON.stringify(expected)}`);
                        }
                        await terminal.flush();
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                } else {
                    throw new Error(`Unknown composed scenario action: ${typed.type}`);
                }
                await terminal.flush();
                await writeHeartbeat();
            }
            await composition.waitForIdle?.(scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS).catch(() => {});
            await terminal.flush();
            await writeHeartbeat();
            const snapshot = composition.runtime.getSessionSnapshot(composition.sessionId);
            const finalScrollback = [restartedTuiHistory, terminal.getScrollbackText()].filter(Boolean).join("\n");
            state.screen = terminal.getScreenText();
            state.scrollback = finalScrollback;
            state.snapshot = snapshot;
            state.activeAgent = snapshot?.activeAgent || state.activeAgent;
            state.editorUsable = snapshot?.busy === false;
            if (scenario.captureGlobalSettings && runwieldDir) {
                state.globalSettings = JSON.parse(await Deno.readTextFile(join(runwieldDir, "settings.json")));
            }
            if (interactionSurface) {
                interactionSurface.assertComplete();
                state.scriptedInteractions = interactionSurface.consumed;
            }
            if (humanReviewSurface) {
                humanReviewSurface.assertComplete();
                state.humanReviews = {
                    consumed: humanReviewSurface.consumed,
                    decisions: consumedHumanReviews,
                };
            }
            if (reviewSurface) {
                assert(
                    pendingReviewLifecycleObservations.length === 0,
                    `Expected every real Plan Review decision to resolve; pending=${pendingReviewLifecycleObservations.length}`,
                );
                reviewSurface.assertComplete();
                let parsedPlan = await Deno.readTextFile(join(Deno.cwd(), "docs", "plans", "plan.md"))
                    .catch(() => Deno.readTextFile(join(Deno.cwd(), "docs", "plans", "epic.md"))).catch(() => "");
                if (!parsedPlan) {
                    for await (const entry of Deno.readDir(join(Deno.cwd(), "docs", "plans"))) {
                        if (entry.isFile && entry.name.endsWith(".md")) {
                            parsedPlan = await Deno.readTextFile(join(Deno.cwd(), "docs", "plans", entry.name));
                            break;
                        }
                    }
                }
                state.planReview = {
                    attrs: parsePlanFrontMatter(parsedPlan).attrs,
                    lifecycleEvents: persistedLifecycleEvents,
                    consumed: reviewSurface.consumed,
                    plan: parsedPlan,
                };
            }
            const result = {
                name: scenario.name,
                state,
                events,
                screenText: terminal.getScreenText(),
                scrollbackText: finalScrollback,
                actor: actor.diagnostics(),
                artifactDir,
            };
            for (const assertion of scenario.assertions || []) await assertion(result);
            actor.assertComplete();
            return result;
        } catch (error) {
            if (options.keepArtifacts !== false) {
                artifactDir = await Deno.makeTempDir({
                    dir: options.artifactRoot,
                    prefix: "runwield-golden-tui-failure-",
                });
                /** @type {Error & { artifactDir?: string }} */ (error instanceof Error
                    ? error
                    : new Error(String(error))).artifactDir = artifactDir;
                if (error && typeof error === "object") {
                    /** @type {{ artifactDir?: string }} */ (error).artifactDir = artifactDir;
                }
                await Deno.writeTextFile(
                    join(artifactDir, "diagnostics.json"),
                    JSON.stringify(
                        {
                            scenario: scenario.name,
                            error: error instanceof Error ? error.message : String(error),
                            screenText: terminal.getScreenText(),
                            scrollback: terminal.getScrollbackText?.(),
                            events,
                            state,
                            actor: actor.diagnostics(),
                            runtime: composition?.runtime.getSessionSnapshot(composition.sessionId),
                            cwd: Deno.cwd(),
                            home: Deno.env.get("HOME"),
                        },
                        null,
                        2,
                    ),
                );
            }
            throw error;
        } finally {
            unsubscribe();
            for (const session of concurrentSessions.values()) {
                session.unsubscribe();
                await session.composition.dispose?.();
            }
            await composition?.dispose?.();
            fauxProvider?.unregister?.();
            if (env) {
                Deno.chdir(previousCwd);
                if (previousHome === undefined) Deno.env.delete("HOME");
                else Deno.env.set("HOME", previousHome);
                await env.cleanup();
                state.cleanupSucceeded = true;
            }
        }
    });
}

/**
 * @param {GoldenScenarioResult} result
 * @param {string} text
 */
export function assertScreenIncludes(result, text) {
    const textSurfaces = [result.screenText, result.scrollbackText || ""];
    assert(
        textSurfaces.some((surfaceText) => surfaceText.includes(text)),
        `Expected screen to include ${JSON.stringify(text)}. Screen:\n${result.screenText}`,
    );
}

/**
 * @param {GoldenScenarioResult} result
 * @param {string} event
 */
export function assertEventIncludes(result, event) {
    assert(result.events.includes(event), `Expected events to include ${event}; got ${result.events.join(", ")}`);
}
