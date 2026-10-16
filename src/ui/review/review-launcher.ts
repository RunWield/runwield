import { captureForegroundProcess } from "../../shared/captured-process.ts";
import process from "node:process";
import type { SequenceReviewDocument } from "../../shared/workflow/sequence-review.ts";
/**
 * @module ui/review/review-launcher
 * Hosts human Plan, code, and artifact review surfaces in Workspace.
 */

import { startReviewWorkspaceServer } from "../../review-workspace-server.ts";
import { parsePlanFrontMatter, resolvePlanExecutionPolicy } from "../../plan-store.js";
import type { PlanExecutionPolicy, PlanFrontMatter } from "../../plan-store.js";
import type { BrowserPort } from "../../shared/browser-port.ts";
import type { GuidedReviewPolicy } from "../../shared/workflow/guided-review.js";

export type ReviewDecisionValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | ReviewDecisionValue[]
    | { [key: string]: ReviewDecisionValue };

export interface ReviewSurface<TDecision = ReviewDecisionValue> {
    url: string;
    opened: boolean;
    waitForDecision(): Promise<TDecision>;
    stop(): void | Promise<void>;
}

export interface ReviewServerOutput {
    stream: "stdout" | "stderr";
    text: string;
}

interface ReviewSurfaceServer<TDecision> {
    url: string;
    waitForDecision(): Promise<TDecision>;
    stop(): void | Promise<void>;
    beginReviewRound?(options: {
        reviewPayload: PlanReviewPayload | CodeReviewPayload;
        reviewConversation?: ReviewConversation;
    }): void;
}

interface PlanReviewPayload {
    sequenceDocuments?: SequenceReviewDocument[];
    plan: string;
    planPath?: string;
    previousPlan?: string;
    planVersions?: Array<{ plan: string; timestamp: string }>;
    classification?: PlanFrontMatter["classification"];
    frontmatter: PlanFrontMatter;
    executionPolicy?: PlanExecutionPolicy;
    agentLabel?: string;
    conversationStatusUrl?: string;
}

interface ReviewSurfaceReady {
    url: string;
    opened: boolean;
}

export interface ReviewConversationEvent {
    type: "assistant_text_delta";
    delta: string;
    messageId: string;
    agentName: string;
}

export interface ReviewConversation {
    onExit?(): void;
    completed?: boolean;
    resultMessage?: string;
    completionDelivered?: boolean;
    id: string;
    agentLabel: string;
    revision: number;
    events: ReviewConversationEvent[];
}

interface PlanReviewSurfaceOptions {
    sequenceDocuments?: SequenceReviewDocument[];
    cwd: string;
    plan: string;
    planPath?: string;
    previousPlan?: string;
    planVersions?: Array<{ plan: string; timestamp: string }>;
    reviewConversation?: ReviewConversation;
    agentLabel?: string;
    token?: string;
    browser: BrowserPort;
    onOutput?(output: ReviewServerOutput): void;
    onSurfaceReady?(surface: ReviewSurfaceReady): void;
    signal?: AbortSignal;
}

interface ArtifactReadSurfaceOptions {
    cwd: string;
    markdown: string;
    artifactKind: "plan" | "prd" | "adr" | "work-record" | "epic-artifact" | "report";
    title: string;
    path?: string;
    imageBaseDir?: string;
    notices?: string[];
    token?: string;
    browser: BrowserPort;
    onOutput?(output: ReviewServerOutput): void;
}

export interface StandaloneForgeState {
    platform: "github" | "gitlab";
    label: string;
    available: boolean;
    unavailableReason?: string;
    postEnabled: boolean;
    postDisabledReason?: string;
}
export interface StandaloneCommitState {
    enabled: boolean;
    disabledReason?: string;
}
export interface StandaloneReviewPayload {
    mode: "pr" | "branch" | "uncommitted";
    /** Selected commit before the Engineer worktree exists. */
    headRef?: string;
    forge?: StandaloneForgeState;
    commit?: StandaloneCommitState;
    reviewContext?: string;
    resultMessage?: string;
}

interface CodeReviewSurfaceOptions {
    standaloneReview?: StandaloneReviewPayload;
    rawPatch: string;
    gitRef: string;
    agentCwd: string;
    targetBranch?: string;
    planName?: string;
    planTitle?: string;
    planContent?: string;
    planAttrs?: { [key: string]: ReviewDecisionValue };
    guidedReview?: GuidedReviewPolicy;
    reviewConversation?: ReviewConversation;
    agentLabel?: string;
    token?: string;
    browser: BrowserPort;
    onSurfaceReady?(surface: ReviewSurfaceReady): void;
}

interface CodeReviewPayload extends Record<string, unknown> {
    standaloneReview?: StandaloneReviewPayload;
    rawPatch: string;
    gitRef: string;
    agentCwd: string;
    targetBranch?: string;
    planName?: string;
    planTitle?: string;
    reviewStatus: CodeReviewStatus;
    planContent?: string;
    planAttrs?: { [key: string]: ReviewDecisionValue };
    guidedReview?: GuidedReviewPolicy;
    agentLabel?: string;
    conversationStatusUrl?: string;
}

const activeReviewSurfaces = new Set<{ stop(): void | Promise<void> }>();
const activePlanReviewConversations = new Map<
    string,
    { server: ReviewSurfaceServer<ReviewDecisionValue>; pageUrl: string }
>();
export async function stopPlanReviewConversationSurface(id: string): Promise<void> {
    const entry = activePlanReviewConversations.get(id);
    if (!entry) return;
    activePlanReviewConversations.delete(id);
    await entry.server.stop();
}

const activeCodeReviewConversations = new Map<
    string,
    { server: ReviewSurfaceServer<ReviewDecisionValue>; pageUrl: string }
>();
let processExitCleanupInstalled = false;
let processExitCleanupSignalHandlers: Array<{ signal: "SIGINT" | "SIGTERM"; handler: () => void }> = [];
let stoppingActiveReviewSurfaces = false;

export async function stopActiveReviewSurfaces(): Promise<void> {
    if (stoppingActiveReviewSurfaces) return;
    stoppingActiveReviewSurfaces = true;
    const surfaces = Array.from(activeReviewSurfaces);
    activeReviewSurfaces.clear();
    activePlanReviewConversations.clear();
    activeCodeReviewConversations.clear();

    try {
        await Promise.all(surfaces.map(async (surface) => {
            try {
                await surface.stop();
            } catch {
                // Exit cleanup is best-effort. Normal per-review cleanup reports failures.
            }
        }));
    } finally {
        stoppingActiveReviewSurfaces = false;
        uninstallProcessExitCleanup();
    }
}

function stopActiveReviewSurfacesBestEffort(): void {
    void stopActiveReviewSurfaces();
}

function installProcessExitCleanup(): void {
    if (processExitCleanupInstalled) return;
    processExitCleanupInstalled = true;
    globalThis.addEventListener("unload", stopActiveReviewSurfacesBestEffort);

    const signals: ReadonlyArray<readonly ["SIGINT" | "SIGTERM", number]> = [
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ];
    for (const [signal, exitCode] of signals) {
        try {
            const handler = (): void => {
                void (async () => {
                    await stopActiveReviewSurfaces();
                    process.exit(exitCode);
                })();
            };
            process.on(signal, handler);
            processExitCleanupSignalHandlers.push({ signal, handler });
        } catch {
            // Some platforms and test environments do not support all signals.
        }
    }
}

function uninstallProcessExitCleanup(): void {
    if (!processExitCleanupInstalled) return;
    globalThis.removeEventListener("unload", stopActiveReviewSurfacesBestEffort);
    for (const { signal, handler } of processExitCleanupSignalHandlers) {
        try {
            process.off(signal, handler);
        } catch {
            // Best-effort cleanup for runtimes without signal support.
        }
    }
    processExitCleanupSignalHandlers = [];
    processExitCleanupInstalled = false;
}

function registerReviewSurface<TDecision>(
    server: ReviewSurfaceServer<TDecision>,
    handlesSignals = false,
): ReviewSurfaceServer<TDecision> {
    if (!handlesSignals) installProcessExitCleanup();
    activeReviewSurfaces.add(server);
    const stop = server.stop.bind(server);
    return {
        ...server,
        async stop(): Promise<void> {
            activeReviewSurfaces.delete(server);
            try {
                await stop();
            } finally {
                if (activeReviewSurfaces.size === 0) uninstallProcessExitCleanup();
            }
        },
    };
}

interface CodeReviewStatus {
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
}

async function loadCodeReviewStatus(cwd: string): Promise<CodeReviewStatus> {
    const empty: CodeReviewStatus = { stagedFiles: [], unstagedFiles: [], untrackedFiles: [] };
    try {
        const output = await captureForegroundProcess("git", { args: ["status", "--porcelain=v1", "-z"], cwd });
        if (!output.success) return empty;
        return parseGitPorcelainStatus(new TextDecoder().decode(output.stdout));
    } catch {
        return empty;
    }
}

function parseGitPorcelainStatus(text: string): CodeReviewStatus {
    const stagedFiles = new Set<string>();
    const unstagedFiles = new Set<string>();
    const untrackedFiles = new Set<string>();
    const parts = text.split("\0").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
        const entry = parts[index];
        if (entry.length < 4) continue;
        const x = entry[0];
        const y = entry[1];
        const path = entry.slice(3);
        if (x === "?" && y === "?") {
            untrackedFiles.add(path);
            continue;
        }
        if (x === "R" || x === "C") index += 1;
        if (x !== " " && x !== "?") stagedFiles.add(path);
        if (y !== " " && y !== "?") unstagedFiles.add(path);
    }
    return {
        stagedFiles: [...stagedFiles],
        unstagedFiles: [...unstagedFiles],
        untrackedFiles: [...untrackedFiles],
    };
}

function workspaceServer<TDecision>(
    options: Parameters<typeof startReviewWorkspaceServer>[0],
) {
    const server = startReviewWorkspaceServer(options);
    return registerReviewSurface<TDecision>({
        ...server,
        url: server.url,
        waitForDecision: () => server.waitForDecision() as Promise<TDecision>,
        stop: () => server.stop(),
    }, Boolean(options.reviewPayload.standaloneReview));
}

export async function startPlanReviewSurface<TDecision = ReviewDecisionValue>({
    cwd,
    sequenceDocuments,
    plan,
    planPath,
    previousPlan,
    planVersions,
    reviewConversation,
    agentLabel,
    token = crypto.randomUUID(),
    browser,
    onOutput,
    onSurfaceReady,
    signal,
}: PlanReviewSurfaceOptions): Promise<ReviewSurface<TDecision>> {
    if (!cwd) throw new Error("startPlanReviewSurface: cwd is required");
    const { attrs } = parsePlanFrontMatter(plan);
    const policy = resolvePlanExecutionPolicy(attrs);
    const executionPolicy = policy.ok ? policy.policy : undefined;
    const resolvedAgentLabel = agentLabel || reviewConversation?.agentLabel || "Planner";
    const reviewPayload = {
        sequenceDocuments,
        plan,
        planPath,
        ...(previousPlan && { previousPlan }),
        ...(planVersions && { planVersions }),
        classification: attrs.classification,
        frontmatter: attrs,
        ...(executionPolicy && { executionPolicy }),
        ...(reviewConversation && {
            agentLabel: resolvedAgentLabel,
            conversationStatusUrl: "/api/review/conversation",
        }),
    };
    const existing = reviewConversation ? activePlanReviewConversations.get(reviewConversation.id) : null;
    if (reviewConversation && existing?.server.beginReviewRound) {
        const conversationId = reviewConversation.id;
        existing.server.beginReviewRound({ reviewPayload, reviewConversation });
        onSurfaceReady?.({ url: existing.pageUrl, opened: false });
        return {
            url: existing.pageUrl,
            opened: false,
            waitForDecision: () => existing.server.waitForDecision() as Promise<TDecision>,
            stop: async () => {
                await stopPlanReviewConversationSurface(conversationId);
            },
        };
    }

    const server = workspaceServer<TDecision>({
        cwd,
        token,
        reviewPayload,
        reviewType: "plan",
        reviewConversation,
        onOutput,
        signal,
    });
    const url = `${server.url}/review/plan?token=${encodeURIComponent(token)}`;
    onSurfaceReady?.({ url, opened: false });
    const opened = await browser.open(url);
    if (reviewConversation) {
        activePlanReviewConversations.set(reviewConversation.id, {
            server: server as ReviewSurfaceServer<ReviewDecisionValue>,
            pageUrl: url,
        });
    }
    return {
        ...server,
        url,
        opened,
        stop: async () => {
            if (reviewConversation) await stopPlanReviewConversationSurface(reviewConversation.id);
            else await server.stop();
        },
    };
}

export async function startArtifactReadSurface<TDecision = ReviewDecisionValue>({
    cwd,
    markdown,
    artifactKind,
    title,
    path,
    imageBaseDir,
    notices = [],
    token = crypto.randomUUID(),
    browser,
    onOutput,
}: ArtifactReadSurfaceOptions): Promise<ReviewSurface<TDecision>> {
    if (!cwd) throw new Error("startArtifactReadSurface: cwd is required");
    const server = workspaceServer<TDecision>({
        cwd,
        token,
        reviewPayload: {
            surface: "artifact-read",
            markdown,
            plan: markdown,
            artifactKind,
            title,
            artifactPath: path,
            imageBaseDir,
            notices,
        },
        reviewType: "plan",
        onOutput,
    });
    const url = `${server.url}/review/plan?token=${encodeURIComponent(token)}`;
    const opened = await browser.open(url);
    return { ...server, url, opened };
}

export async function startCodeReviewSurface<TDecision = ReviewDecisionValue>({
    standaloneReview,
    rawPatch,
    gitRef,
    agentCwd,
    targetBranch,
    planName,
    planTitle,
    planContent,
    planAttrs,
    guidedReview,
    reviewConversation,
    agentLabel,
    token = crypto.randomUUID(),
    browser,
    onSurfaceReady,
}: CodeReviewSurfaceOptions): Promise<ReviewSurface<TDecision>> {
    if (!agentCwd) throw new Error("startCodeReviewSurface: agentCwd is required");
    const reviewStatus = await loadCodeReviewStatus(agentCwd);
    const resolvedAgentLabel = agentLabel || reviewConversation?.agentLabel || "Reviewer Feedback Engineer";
    const reviewPayload: CodeReviewPayload = {
        standaloneReview,
        rawPatch,
        gitRef,
        agentCwd,
        targetBranch,
        planName,
        planTitle,
        reviewStatus,
        planContent,
        planAttrs,
        guidedReview,
        ...(reviewConversation && {
            agentLabel: resolvedAgentLabel,
            conversationStatusUrl: "/api/review/conversation",
        }),
    };
    const existing = reviewConversation ? activeCodeReviewConversations.get(reviewConversation.id) : null;
    if (reviewConversation && existing?.server.beginReviewRound) {
        const conversationId = reviewConversation.id;
        existing.server.beginReviewRound({ reviewPayload, reviewConversation });
        onSurfaceReady?.({ url: existing.pageUrl, opened: false });
        return {
            url: existing.pageUrl,
            opened: false,
            waitForDecision: () => existing.server.waitForDecision() as Promise<TDecision>,
            stop: async () => {
                activeCodeReviewConversations.delete(conversationId);
                await existing.server.stop();
            },
        };
    }
    const server = workspaceServer<TDecision>({
        cwd: agentCwd,
        token,
        reviewPayload,
        reviewType: "code",
        reviewConversation,
    });
    const url = `${server.url}/review/code?token=${encodeURIComponent(token)}`;
    const opened = await browser.open(url);
    onSurfaceReady?.({ url, opened });
    if (reviewConversation) {
        activeCodeReviewConversations.set(reviewConversation.id, {
            server: server as ReviewSurfaceServer<ReviewDecisionValue>,
            pageUrl: url,
        });
    }
    return {
        ...server,
        url,
        opened,
        stop: async () => {
            if (reviewConversation) activeCodeReviewConversations.delete(reviewConversation.id);
            await server.stop();
        },
    };
}
