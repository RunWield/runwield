import { execFileSync } from "node:child_process";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { AGENTS, getCwd, getHomeDir, RUNWIELD_DIR_NAME } from "../../constants.js";
import { getSettingsManager } from "../../shared/settings.js";
import { getAgentDisplayName } from "../../shared/session/agents.js";
import { createSessionSnapshotWindow } from "./session-snapshot-window.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { readRunWieldPackageInstallSync } from "../../shared/package-install.ts";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface FooterTheme {
    fg(token: ThemeColor | string, text: string): string;
}
export interface FooterContextUsage {
    contextWindow?: number;
    percent?: number | null;
}
export interface FooterContextStat {
    text: string;
    token: "dim" | "warning" | "error";
}
export interface FooterWorkflowPart {
    text: string;
    token: string;
}
export interface FooterLocationSnapshot {
    cwd?: string;
    activeExecutionWorkflow?: { executionCwd?: string; worktreeBranch?: string } | null;
}
export interface FooterLocationOptions {
    home?: string;
    resolveBranch?: (cwd: string) => string | undefined;
}
export interface FooterRuntimeUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}
export interface FooterRuntimeSnapshot extends FooterLocationSnapshot {
    activeModel: { model?: string; provider?: string };
    thinkingLevel: string;
    activeAgent?: string | null;
    activeAgentInfo?: { displayName?: string; agentName?: string } | null;
    workflowContext?: { routingIntent?: string; complexity?: string; planName?: string } | null;
    contextUsage?: FooterContextUsage | null;
    autoCompactionEnabled?: boolean | null;
}
export interface FooterUsageEvent {
    type: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
    };
}
export type FooterRuntimeEvent = FooterUsageEvent | { type: string };
export interface ChatFooterController {
    component: Component;
    markCtrlCPendingExit(): void;
    isCtrlCPendingExit(): boolean;
    rebindSession(sessionId: string): void;
    dispose(): void;
}
export interface CreateChatFooterControllerOptions {
    runtime: SessionRuntime;
    getSessionId(): string;
    requestRender(): void;
}

function formatTokens(count: number): string {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

export function renderUpdateNoticeLine(latestVersion: string, themeImpl: FooterTheme = theme): string {
    const command = readRunWieldPackageInstallSync()?.updateCommand || "wld update";
    return `New version available: ${
        themeImpl.fg("routingQuickFix" as ThemeColor, latestVersion)
    }. Run \`${command}\` to install it`;
}

export function buildFooterContextStat(
    contextUsage: FooterContextUsage | null | undefined,
    autoCompactionEnabled: boolean | null | undefined,
): FooterContextStat | null {
    const contextWindow = Number(contextUsage?.contextWindow ?? 0) || 0;
    if (contextWindow <= 0) return null;
    const percent = typeof contextUsage?.percent === "number" ? contextUsage.percent : null;
    const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
    const autoCompactText = autoCompactionEnabled === false ? "" : " (Auto-compact)";
    const token = percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "dim";
    return { text: `${percentText}/${formatTokens(contextWindow)}${autoCompactText}`, token };
}

export function shouldShowFooterThinkingLevel(modelStr: string, thinkingLevel: string): boolean {
    return Boolean(modelStr) && thinkingLevel !== "off";
}

const FOOTER_WORKFLOW_EXCLUDED_AGENT_NAMES = new Set([AGENTS.IDEATOR, AGENTS.OPERATOR, AGENTS.GUIDE]);
const FOOTER_WORKFLOW_EXCLUDED_DISPLAY_NAMES = new Set(["ideator", "operator", "guide"]);
const FOOTER_ROUTING_META = new Map([
    ["QUICK_FIX", { label: "Quick Fix", token: "routingQuickFix" }],
    ["PLANNED_CHANGE", { label: "Planned Change", token: "routingFeature" }],
    ["FEATURE", { label: "Planned Change", token: "routingFeature" }],
    ["PROJECT", { label: "Epic", token: "routingEpic" }],
]);
const FOOTER_COMPLEXITY_META = new Map([
    ["LOW", { label: "Low", token: "complexityLow" }],
    ["MEDIUM", { label: "Medium", token: "complexityMedium" }],
    ["HIGH", { label: "High", token: "complexityHigh" }],
]);

export function shouldShowFooterWorkflowContext(
    agentInfo: { displayName?: string; agentName?: string } | null | undefined,
): boolean {
    const agentName = typeof agentInfo?.agentName === "string" ? agentInfo.agentName.trim().toLowerCase() : "";
    if (agentName) return !FOOTER_WORKFLOW_EXCLUDED_AGENT_NAMES.has(agentName);
    const displayName = typeof agentInfo?.displayName === "string" ? agentInfo.displayName.trim().toLowerCase() : "";
    return !FOOTER_WORKFLOW_EXCLUDED_DISPLAY_NAMES.has(displayName);
}

export function getFooterWorkflowLabelText(parts: FooterWorkflowPart[]): string {
    return parts.map((part) => part.text).join("");
}

export function buildFooterWorkflowLabelParts(
    agentInfo: { displayName?: string; agentName?: string } | null | undefined,
    workflowContext: { routingIntent?: string; complexity?: string; planName?: string } | null | undefined,
    maxWidth = Infinity,
): FooterWorkflowPart[] {
    const agentName = typeof agentInfo?.displayName === "string" && agentInfo.displayName.trim()
        ? agentInfo.displayName.trim()
        : "";
    const width = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : Infinity;
    if (!agentName || width <= 0) return [];
    const routeMeta = FOOTER_ROUTING_META.get(String(workflowContext?.routingIntent || ""));
    const complexityMeta = FOOTER_COMPLEXITY_META.get(String(workflowContext?.complexity || ""));
    const planName = typeof workflowContext?.planName === "string" ? workflowContext.planName.trim() : "";
    const showContext = shouldShowFooterWorkflowContext(agentInfo);
    const showRouting = Boolean(showContext && routeMeta && complexityMeta);
    const showPlan = showContext && Boolean(planName);
    if (!showRouting && !showPlan) return [{ text: truncateToWidth(agentName, width), token: "accent" }];
    function compose(
        options: { includeComplexity: boolean; includePlan: boolean; planText?: string },
    ): FooterWorkflowPart[] {
        const parts: FooterWorkflowPart[] = [{ text: agentName, token: "accent" }];
        if (showRouting && routeMeta && complexityMeta) {
            parts.push({ text: " - ", token: "dim" });
            if (options.includeComplexity) {
                parts.push({ text: complexityMeta.label, token: complexityMeta.token });
                parts.push({ text: " ", token: "dim" });
            }
            parts.push({ text: routeMeta.label, token: routeMeta.token });
        }
        if (options.includePlan) {
            parts.push({ text: " - ", token: "dim" });
            parts.push({ text: options.planText || planName, token: "dim" });
        }
        return parts;
    }
    let parts = compose({ includeComplexity: true, includePlan: showPlan });
    if (visibleWidth(getFooterWorkflowLabelText(parts)) <= width) return parts;
    if (showPlan) {
        const withoutPlan = compose({ includeComplexity: true, includePlan: false });
        const planMax = width - visibleWidth(getFooterWorkflowLabelText(withoutPlan)) - visibleWidth(" - ");
        if (planMax > 0) {
            parts = compose({
                includeComplexity: true,
                includePlan: true,
                planText: truncateToWidth(planName, planMax),
            });
            if (visibleWidth(getFooterWorkflowLabelText(parts)) <= width) return parts;
        }
        parts = withoutPlan;
        if (visibleWidth(getFooterWorkflowLabelText(parts)) <= width) return parts;
    }
    if (showRouting) {
        parts = compose({ includeComplexity: false, includePlan: false });
        if (visibleWidth(getFooterWorkflowLabelText(parts)) <= width) return parts;
    }
    return [{ text: truncateToWidth(getFooterWorkflowLabelText(parts), width), token: "accent" }];
}

export function renderFooterWorkflowLabelParts(parts: FooterWorkflowPart[], themeImpl: FooterTheme = theme): string {
    return parts.map((part) => themeImpl.fg(part.token as ThemeColor, part.text)).join("");
}

function readGitBranchSync(cwd: string): string | undefined {
    try {
        return execFileSync("git", ["branch", "--show-current"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}
function lastPathSegment(path: string): string {
    return path.split(/[\\/]+/).filter(Boolean).at(-1) || "";
}
function projectLabelFromEncodedWorktreeParent(encodedProjectCwd: string): string {
    return encodedProjectCwd.replace(/^--/, "").replace(/--$/, "").split("-").filter(Boolean).at(-1) || "";
}
function formatManagedWorktreeCwd(cwd: string, home: string, projectCwd: string | null | undefined): string | null {
    if (!home) return null;
    const worktreesPrefix = `${home}/${RUNWIELD_DIR_NAME}/worktrees/`;
    if (!cwd.startsWith(worktreesPrefix)) return null;
    const parts = cwd.slice(worktreesPrefix.length).split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const projectLabel = lastPathSegment(projectCwd || "") || projectLabelFromEncodedWorktreeParent(parts[0]);
    return projectLabel ? `${projectLabel}/${parts.slice(1).join("/")}` : null;
}
function formatFooterCwd(cwd: string, home: string, projectCwd?: string | null): string {
    const managedWorktreeCwd = formatManagedWorktreeCwd(cwd, home, projectCwd);
    if (managedWorktreeCwd) return managedWorktreeCwd;
    if (!home) return cwd;
    if (cwd === home) return "~";
    return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}
export function buildFooterLocationText(snapshot: FooterLocationSnapshot, options: FooterLocationOptions = {}): string {
    const home = options.home ?? getHomeDir();
    const executionWorkflow = snapshot.activeExecutionWorkflow;
    const footerCwd = executionWorkflow?.executionCwd || snapshot.cwd || getCwd();
    const branch = executionWorkflow?.worktreeBranch || options.resolveBranch?.(footerCwd) || "unknown";
    return `${formatFooterCwd(footerCwd, home, executionWorkflow?.executionCwd ? snapshot.cwd : null)} (${branch})`;
}
export function buildFooterLine1Parts(
    agentInfo: { displayName?: string; agentName?: string } | null | undefined,
    workflowContext: { routingIntent?: string; complexity?: string; planName?: string } | null | undefined,
    leftRaw: string,
    width: number,
): { left: string; rightParts: FooterWorkflowPart[] } {
    const priorityRightParts = buildFooterWorkflowLabelParts(
        agentInfo,
        workflowContext ? { ...workflowContext, planName: "" } : workflowContext,
        Infinity,
    );
    const leftMax = Math.max(0, width - visibleWidth(getFooterWorkflowLabelText(priorityRightParts)) - 1);
    const left = truncateToWidth(leftRaw, leftMax);
    const rightMax = Math.max(0, width - visibleWidth(left) - 1);
    return { left, rightParts: buildFooterWorkflowLabelParts(agentInfo, workflowContext, rightMax) };
}

const thinkingLevelTheme = new Map([
    ["off", "thinkingOff"],
    ["minimal", "thinkingMinimal"],
    ["low", "thinkingLow"],
    ["medium", "thinkingMedium"],
    ["high", "thinkingHigh"],
    ["xhigh", "thinkingXhigh"],
    ["max", "thinkingMax"],
]);
function getThinkingThemeToken(level: string): string {
    return thinkingLevelTheme.get(level) || "thinkingOff";
}
function isUsageEvent(event: FooterRuntimeEvent): event is FooterUsageEvent {
    return event.type === RuntimeEventTypes.USAGE && "usage" in event;
}

export function createChatFooterController(options: CreateChatFooterControllerOptions): ChatFooterController {
    const runtimeUsage: FooterRuntimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let unsubscribeRuntimeTelemetry = () => {};
    let ctrlCPendingExit = false;
    let ctrlCPendingTimer: ReturnType<typeof setTimeout> | null = null;
    const footerBranchCache = new Map<string, string>();
    const snapshotWindow = createSessionSnapshotWindow(options.runtime, options.getSessionId);
    const getCachedFooterBranch = (branchCwd: string): string => {
        if (!footerBranchCache.has(branchCwd)) {
            footerBranchCache.set(branchCwd, readGitBranchSync(branchCwd) || "unknown");
        }
        return footerBranchCache.get(branchCwd) || "unknown";
    };
    function attachRuntimeTelemetry(sessionId: string): void {
        unsubscribeRuntimeTelemetry();
        runtimeUsage.input = 0;
        runtimeUsage.output = 0;
        runtimeUsage.cacheRead = 0;
        runtimeUsage.cacheWrite = 0;
        runtimeUsage.cost = 0;
        unsubscribeRuntimeTelemetry = options.runtime.subscribeSessionEvents(sessionId, (event) => {
            if (!isUsageEvent(event)) return;
            runtimeUsage.input += event.usage.inputTokens;
            runtimeUsage.output += event.usage.outputTokens;
            runtimeUsage.cacheRead += event.usage.cacheReadTokens;
            runtimeUsage.cacheWrite += event.usage.cacheWriteTokens;
            runtimeUsage.cost += event.usage.costUsd;
        });
    }
    function getModelAndProvider(
        snapshot: FooterRuntimeSnapshot,
    ): { model: string; provider: string; thinkingLevel: string } {
        const settingsManager = getSettingsManager(snapshot.cwd);
        let model = settingsManager.getDefaultModel() ?? "";
        let provider = settingsManager.getDefaultProvider() ?? "";
        const activeModel = snapshot.activeModel;
        if (activeModel.model) {
            const slashIndex = activeModel.model.indexOf("/");
            if (slashIndex > 0) {
                provider = activeModel.model.slice(0, slashIndex);
                model = activeModel.model.slice(slashIndex + 1);
            } else {
                model = activeModel.model;
                if (activeModel.provider) provider = activeModel.provider;
            }
        } else if (activeModel.provider) provider = activeModel.provider;
        return { model, provider, thinkingLevel: snapshot.thinkingLevel };
    }
    const component: Component = {
        invalidate: () => {},
        render: (w: number) => {
            const snapshot = snapshotWindow.read();
            if (!snapshot) return ["", ctrlCPendingExit ? theme.fg("warning", "Ctrl+C - Press again to exit") : ""];
            const { model, provider, thinkingLevel } = getModelAndProvider(snapshot);
            const modelStr = model
                ? provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model
                : "";
            const rootAgentName = snapshot.activeAgent || "";
            const activeAgentInfo = snapshot.activeAgentInfo ||
                {
                    displayName: rootAgentName ? getAgentDisplayName(rootAgentName, snapshot.cwd) : "",
                    agentName: rootAgentName,
                };
            const line1LeftRaw = buildFooterLocationText(snapshot, { resolveBranch: getCachedFooterBranch });
            const { left: line1Left, rightParts: line1RightParts } = buildFooterLine1Parts(
                activeAgentInfo,
                snapshot.workflowContext,
                line1LeftRaw,
                w,
            );
            const line1RightText = getFooterWorkflowLabelText(line1RightParts);
            const line1 = theme.fg("dim", line1Left) +
                " ".repeat(Math.max(1, w - visibleWidth(line1Left) - visibleWidth(line1RightText))) +
                renderFooterWorkflowLabelParts(line1RightParts);
            const contextStat = buildFooterContextStat(snapshot.contextUsage, snapshot.autoCompactionEnabled);
            const statsParts: string[] = [];
            if (runtimeUsage.input > 0) statsParts.push(`↑${formatTokens(runtimeUsage.input)}`);
            if (runtimeUsage.output > 0) statsParts.push(`↓${formatTokens(runtimeUsage.output)}`);
            if (runtimeUsage.cacheRead > 0) statsParts.push(`R${formatTokens(runtimeUsage.cacheRead)}`);
            if (runtimeUsage.cacheWrite > 0) statsParts.push(`W${formatTokens(runtimeUsage.cacheWrite)}`);
            if (runtimeUsage.cost > 0) statsParts.push(`$${runtimeUsage.cost.toFixed(3)}`);
            if (contextStat) statsParts.push(theme.fg(contextStat.token, contextStat.text));
            const showThinkingLevel = shouldShowFooterThinkingLevel(modelStr, thinkingLevel);
            const thinkingStr = `(${thinkingLevel})`;
            const line2RightWidth = visibleWidth(modelStr) + (showThinkingLevel ? visibleWidth(thinkingStr) + 1 : 0);
            const line2LeftRaw = ctrlCPendingExit ? "Ctrl+C - Press again to exit" : statsParts.join(" ");
            const line2LeftTrunc = truncateToWidth(line2LeftRaw, Math.max(0, w - line2RightWidth - 1));
            const line2LeftStyled = ctrlCPendingExit
                ? theme.fg("warning", line2LeftTrunc)
                : theme.fg("dim", line2LeftTrunc);
            const line2 = line2LeftStyled +
                " ".repeat(Math.max(1, w - visibleWidth(line2LeftTrunc) - line2RightWidth)) +
                theme.fg("dim", modelStr) +
                (showThinkingLevel
                    ? " " + theme.fg(getThinkingThemeToken(thinkingLevel) as ThemeColor, thinkingStr)
                    : "");
            return [line1, line2];
        },
    };
    attachRuntimeTelemetry(options.getSessionId());
    return {
        component,
        markCtrlCPendingExit() {
            ctrlCPendingExit = true;
            if (ctrlCPendingTimer) clearTimeout(ctrlCPendingTimer);
            ctrlCPendingTimer = setTimeout(() => {
                ctrlCPendingExit = false;
                ctrlCPendingTimer = null;
                options.requestRender();
            }, 1000);
            options.requestRender();
        },
        isCtrlCPendingExit() {
            return ctrlCPendingExit;
        },
        rebindSession(sessionId: string) {
            snapshotWindow.rebind();
            snapshotWindow.invalidate();
            attachRuntimeTelemetry(sessionId);
        },
        dispose() {
            snapshotWindow.dispose();
            unsubscribeRuntimeTelemetry();
            if (ctrlCPendingTimer) clearTimeout(ctrlCPendingTimer);
            ctrlCPendingTimer = null;
            ctrlCPendingExit = false;
        },
    };
}
