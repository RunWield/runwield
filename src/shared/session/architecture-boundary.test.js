import { assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { createSessionRuntime, SessionRuntime } from "./session-runtime.ts";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../../..");
const SKIPPED_SOURCE_DIRECTORIES = new Set([".astro", "dist", "node_modules"]);

/** @param {string} path @returns {Promise<string[]>} */
async function productionSourceFiles(path) {
    const files = [];
    for await (const entry of Deno.readDir(path)) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory) {
            if (SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) continue;
            files.push(...await productionSourceFiles(entryPath));
            continue;
        }
        if (!entry.isFile || !/\.[jt]sx?$/.test(entry.name)) continue;
        if (/\.test\.[jt]sx?$/.test(entry.name) || /_test\.[jt]sx?$/.test(entry.name)) continue;
        files.push(entryPath);
    }
    return files;
}

/** @param {string} path @returns {Promise<string[]>} */
async function productionJavaScriptFiles(path) {
    return (await productionSourceFiles(path)).filter((file) => /\.jsx?$/.test(file));
}

/**
 * @typedef {Object} SourceRule
 * @property {string} label
 * @property {RegExp} pattern
 * @property {(path: string) => boolean} [allowPath]
 * @property {(path: string, source: string) => string} [sourceForRule]
 */

/**
 * @param {string[]} roots
 * @param {SourceRule[]} rules
 * @param {{ javascriptOnly?: boolean }} [options]
 */
async function findViolations(roots, rules, options = {}) {
    const violations = [];
    for (const root of roots) {
        const files = options.javascriptOnly
            ? await productionJavaScriptFiles(join(REPO_ROOT, root))
            : await productionSourceFiles(join(REPO_ROOT, root));
        for (const file of files) {
            const path = relative(REPO_ROOT, file);
            const source = await Deno.readTextFile(file);
            for (const rule of rules) {
                if (rule.allowPath?.(path)) continue;
                const ruleSource = rule.sourceForRule?.(path, source) || source;
                if (rule.pattern.test(ruleSource)) violations.push(`${path}: ${rule.label}`);
            }
        }
    }
    return violations;
}

/**
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
function resolvedImportTargets(file, source) {
    const targets = [];
    const importPattern =
        /(?:import\s+(?:[^"']*?\s+from\s*)?|export\s+[^"']*?\s+from\s*|import\s*\()\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        targets.push(relative(REPO_ROOT, resolve(dirname(file), specifier)));
    }
    return targets;
}

/**
 * Workspace Session and Plan progress projections need `getRunWieldSessionDir` to locate committed transcript files for
 * read-only projection. They must not import other root-session internals or use root-session as a writable Runtime
 * escape hatch.
 * @param {string} path
 * @param {string} source
 */
function sourceWithoutApprovedWorkspaceRootSessionDirImport(path, source) {
    const allowed = new Set([
        "src/ui/workspace/server/session-continuation.js",
        "src/ui/workspace/server/owner-plan-progress.ts",
    ]);
    if (!allowed.has(path)) return source;
    return source.replace(
        /^import \{ getRunWieldSessionDir \} from "\.\.\/\.\.\/\.\.\/shared\/session\/root-session\.js";\n/m,
        "",
    );
}

Deno.test("core has no consumer presentation knowledge", async () => {
    const violations = await findViolations(["src/shared", "src/tools"], [
        { label: "UI API reference", pattern: /\buiAPI\b|\bUiAPI\b|SessionUiPort/ },
        { label: "consumer name", pattern: /\bTUI\b|\bACP\b|Plannotator/ },
        { label: "consumer import", pattern: /(?:from|import\()\s*["'][^"']*(?:\/ui\/|\/acp\/)/ },
    ], { javascriptOnly: true });
    assertEquals(violations, []);
});

Deno.test("TUI, ACP, and Workspace remain sibling Runtime consumers", async () => {
    const violations = [];
    const surfaceRules = [
        { root: "src/ui/tui", forbidden: ["src/acp", "src/ui/workspace"] },
        { root: "src/acp", forbidden: ["src/ui/tui", "src/ui/workspace"] },
        { root: "src/ui/workspace", forbidden: ["src/ui/tui", "src/acp"] },
    ];

    for (const { root, forbidden } of surfaceRules) {
        for (const file of await productionSourceFiles(join(REPO_ROOT, root))) {
            const path = relative(REPO_ROOT, file);
            const source = await Deno.readTextFile(file);
            for (const target of resolvedImportTargets(file, source)) {
                if (forbidden.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
                    violations.push(`${path}: sibling adapter import ${target}`);
                }
            }
        }
    }

    assertEquals(violations, []);
});

Deno.test("Core session surfaces do not open or import the Workspace database", async () => {
    const violations = await findViolations(["src/ui/tui", "src/acp"], [
        {
            label: "Workspace database dependency",
            pattern: /shared\/owner-coordination|openOwnerCoordination|owner-coordination\.sqlite3/,
        },
    ]);
    const runtimeSources = await Promise.all(
        (await productionSourceFiles(join(REPO_ROOT, "src/shared/session/runtime"))).map((file) =>
            Deno.readTextFile(file)
        ),
    );
    const runtimeSource = runtimeSources.join("\n");
    const runtimeImportsWorkspaceStore = /from\s+["'][^"']*owner-coordination\/index\.js["']/.test(runtimeSource) ||
        /openOwnerCoordinationStore\s*\(/.test(runtimeSource);
    if (runtimeImportsWorkspaceStore) {
        violations.push("src/shared/session/session-runtime.ts: Workspace database dependency");
    }
    assertEquals(violations, []);
});

Deno.test("TUI, ACP, Workspace, commands, and scripts use the public Runtime surface only", async () => {
    const violations = await findViolations(["src/ui/tui", "src/acp", "src/ui/workspace", "src/cmd", "scripts"], [
        {
            label: "HostedSession reference",
            pattern: /HostedSession|hosted-session/,
            allowPath: (path) => path === "src/ui/tui/testing/session-view-fixture.ts",
        },
        {
            label: "SessionHost reference",
            pattern: /SessionHost|session-host/,
            allowPath: (path) => path === "src/ui/tui/testing/session-view-fixture.ts",
        },
        {
            label: "root-session internal access",
            pattern: /getRootAgentSession|getRootSessionManager|createRootSessionManager|openPersistedRootSession/,
        },
        { label: "session implementation import", pattern: /shared\/session\/session\.js/ },
        {
            label: "session internal import",
            pattern: /shared\/session\/(?:agent-handler|agent-switching|root-session|hosted-session|session-host)\.js/,
            sourceForRule: sourceWithoutApprovedWorkspaceRootSessionDirImport,
            allowPath: (path) => path === "src/ui/tui/testing/session-view-fixture.ts",
        },
        { label: "Runtime host escape", pattern: /\.sessionHost\b|\.getSession\s*\(/ },
        { label: "Runtime event producer escape", pattern: /\.emitSessionEvent\s*\(/ },
        { label: "Runtime transcript-internal escape", pattern: /\.recordLocalToolExchange\s*\(/ },
        {
            label: "consumer-side Runtime event production or normalization",
            pattern:
                /createSessionRuntimeEvent|emitHostedSessionRuntimeEvent|normalizeRuntimeToolResult|normalizeRuntimeUsage|describeRuntimeTool|formatToolEventTitle/,
        },
        {
            label: "parallel operation-cancellation seam",
            pattern: /registerOperationCancel|cancelSessionCompaction/,
        },
    ]);
    assertEquals(violations, []);
});

Deno.test("writable transcript hydration stays inside SessionRuntime lease enforcement", async () => {
    const allowed = new Set([
        "src/shared/session/root-session.js",
        "src/shared/session/segment-rollover.ts",
        "src/shared/session/runtime/images.ts",
        "src/shared/session/runtime/lifecycle-loading.ts",
        "src/shared/session/runtime/lifecycle.ts",
        "src/shared/session/runtime/managed-operations.ts",
    ]);
    const violations = await findViolations(["src", "scripts"], [
        {
            label: "writable transcript open outside SessionRuntime and root-session helpers",
            pattern: /SessionManager\.open|openPersistedRootSession|createRootSessionManager/,
            allowPath: (path) => allowed.has(path),
        },
    ]);
    assertEquals(violations, []);
});

Deno.test("Session writer mutators stay behind approved state-machine seams", async () => {
    const violations = await findViolations(["src", "scripts"], [
        {
            label: "Session Activation Lease mutator outside Runtime or approved coordination service",
            pattern:
                /\b(?:acquireSessionActivation|changeSessionActivationPhase|heartbeatSessionActivation|publishGenerationAndRelease|releaseUnchangedActivation|markSessionUncertain|markSessionReconcileRequired)\s*\(/,
            allowPath: (path) =>
                path.startsWith("src/shared/owner-coordination/") ||
                path === "src/shared/session/file-session-store.ts" ||
                path === "src/shared/session/file-session-control.ts" ||
                path === "src/shared/session/file-session-store-types.ts" ||
                path === "src/shared/session/segment-rollover.ts" ||
                path === "src/shared/session/runtime/lifecycle-loading.ts" ||
                path === "src/shared/session/runtime/lifecycle.ts" ||
                path === "src/shared/session/runtime/managed-operations.ts" ||
                path === "src/shared/session/runtime/managed-sync.ts" ||
                path === "src/ui/workspace/server/session-continuation.js" ||
                path === "src/ui/workspace/server/owner-plan-actions.ts",
        },
    ]);
    assertEquals(violations, []);
});

Deno.test("the file Session contract is host-neutral and the store remains decomposed", async () => {
    const contract = await Deno.readTextFile(join(REPO_ROOT, "src/shared/session/file-session-store-types.ts"));
    assertEquals(/owner-coordination|heartbeat|activation.?protocol|expired/i.test(contract), false);

    const facade = await Deno.readTextFile(join(REPO_ROOT, "src/shared/session/file-session-store.ts"));
    assertEquals(facade.split("\n").length <= 650, true);
    assertEquals(facade.includes("createFileSessionControl"), true);
});

Deno.test("non-owning Session generation synchronization remains read-only", async () => {
    const violations = [];
    const workspaceContinuationSource = await Deno.readTextFile(
        join(REPO_ROOT, "src/ui/workspace/server/session-continuation.js"),
    );
    const timelineIndex = workspaceContinuationSource.indexOf("async timeline(runwieldSessionId, options = {})");
    const bootstrapIndex = workspaceContinuationSource.indexOf("async bootstrap(options)", timelineIndex);
    const timelineBody = workspaceContinuationSource.slice(timelineIndex, bootstrapIndex);
    if (
        /\b(?:loadSession|adoptManagedSession|promptSession|promptManagedSession|openPersistedRootSession)\s*\(/.test(
            timelineBody,
        )
    ) {
        violations.push("src/ui/workspace/server/session-continuation.js: timeline hydrates writable Runtime state");
    }
    if (/SessionManager\.open/.test(timelineBody)) {
        violations.push("src/ui/workspace/server/session-continuation.js: timeline opens writable SessionManager");
    }

    for (const file of await productionSourceFiles(join(REPO_ROOT, "src/ui/tui"))) {
        const path = relative(REPO_ROOT, file);
        if (!/(managed-session-sync|chat-session)\.[jt]sx?$/.test(path)) continue;
        const source = await Deno.readTextFile(file);
        if (/SessionManager\.open|openPersistedRootSession/.test(source)) {
            violations.push(`${path}: managed Session synchronization opens writable transcript state`);
        }
        if (
            /\b(?:runtime|sessionRuntime|options\.runtime)\.(?:loadSession|adoptManagedSession|promptSession|promptManagedSession)\s*\(/
                .test(
                    source,
                )
        ) {
            violations.push(`${path}: managed Session synchronization hydrates or prompts through Runtime`);
        }
    }

    assertEquals(violations, []);
});

Deno.test("stable RunWield Session IDs are not confused with Hosted or Pi session ids", async () => {
    const violations = await findViolations(["src", "scripts"], [
        {
            label: "stable runwieldSessionId assigned from in-process or Pi session id",
            pattern: /\brunwieldSessionId\s*:\s*(?:session\.id|runtimeSessionId|sessionManagerId|piSessionId)\b/,
        },
        {
            label: "owner Session id assigned from in-process session id",
            pattern: /\bownerSessionId\s*:\s*session\.id\b/,
        },
    ]);
    assertEquals(violations, []);
});

Deno.test("session/Pi coupling in workflow validation stays at the adapter boundary", async () => {
    // The session-independent validation engine must not creep back toward the
    // session runtime: any production `validation*.ts` module in shared/workflow
    // that imports Pi packages or ../session/ modules must be one of the whitelisted
    // entry/adapter/sibling files. Green both before and after the engine split, so
    // it guards the future: a renamed monolith or a new session-coupled engine
    // module fails it.
    const validationAdapterWhitelist = new Set([
        "src/shared/workflow/validation.ts",
        "src/shared/workflow/validation-session-adapter.ts",
        "src/shared/workflow/validation-helpers.ts",
        "src/shared/workflow/validation-local-ci.ts",
        "src/shared/workflow/validation-position.ts",
        "src/shared/workflow/validation-progress.ts",
        "src/shared/workflow/validation-prompts.ts",
    ]);
    const violations = [];
    for (const file of await productionSourceFiles(join(REPO_ROOT, "src/shared/workflow"))) {
        const path = relative(REPO_ROOT, file);
        if (!/validation[^/]*\.ts$/.test(path)) continue;
        if (validationAdapterWhitelist.has(path)) continue;
        const source = await Deno.readTextFile(file);
        if (
            /(?:from|import\()\s*["'][^"']*@earendil-works[^"']*["']/.test(source) ||
            /(?:from|import\()\s*["'][^"']*\.\.\/session\/[^"']*["']/.test(source)
        ) {
            violations.push(`${path}: session/Pi import outside the validation adapter boundary`);
        }
    }
    assertEquals(violations, []);
});

Deno.test("active and isolated Agents have exactly one production lifecycle boundary each", async () => {
    const files = await productionSourceFiles(join(REPO_ROOT, "src"));
    const activeMutationModules = new Set([
        "src/shared/session/hosted-session.js",
        "src/shared/session/session.js",
        "src/shared/session/agent-switching.js",
    ]);
    const activeTurnModules = new Set([
        "src/shared/session/session.js",
        "src/shared/session/agent-handler.js",
        "src/shared/session/agent-handler.ts",
        "src/shared/session/agent-switching.js",
        "src/shared/session/root-workflow-turn.ts",
        "src/shared/workflow/orchestrator.ts",
    ]);
    const violations = [];

    for (const file of files) {
        const path = relative(REPO_ROOT, file);
        const source = await Deno.readTextFile(file);
        if (/\brunAgentSession\b|\buseRootSession\b/.test(source)) {
            violations.push(`${path}: legacy mixed root/isolated Agent runner`);
        }
        if (
            !activeMutationModules.has(path) &&
            /\b(?:setRootAgentSession|setRootAgentName|setActiveOnMessage|ensureRootAgentSession)\b/.test(source)
        ) {
            violations.push(`${path}: active Agent state mutation outside activation transaction`);
        }
        if (!activeTurnModules.has(path) && /\brunRootTurn\s*\(/.test(source)) {
            violations.push(`${path}: direct interactive root turn outside active Agent boundary`);
        }
    }

    assertEquals(violations, []);
});

Deno.test("command surfaces do not use SessionSnapshot as active runtime authority", async () => {
    const violations = await findViolations(["src/cmd"], [
        {
            label: "active Agent read from display SessionSnapshot",
            pattern: /getSessionSnapshot\s*\([^)]*\)\?\.activeAgent\b/,
        },
        {
            label: "active execution workflow read from display SessionSnapshot",
            pattern: /getSessionSnapshot\s*\([^)]*\)\?\.activeExecutionWorkflow\b/,
        },
    ]);

    assertEquals(violations, []);
});

Deno.test("managed projection caches do not drive live activation transitions", async () => {
    const runtimeSource = await Deno.readTextFile(
        join(REPO_ROOT, "src/shared/session/runtime/managed-operations.ts"),
    );
    const workflowOperationIndex = runtimeSource.indexOf("async runManagedOperation<T>(");
    const activationTail = runtimeSource.slice(workflowOperationIndex);
    const hostedSource = await Deno.readTextFile(join(REPO_ROOT, "src/shared/session/hosted-session.js"));
    const setManagedIndex = hostedSource.indexOf("setManagedMetadata(metadata)");
    const getManagedIndex = hostedSource.indexOf("getManagedMetadata()", setManagedIndex);
    const setManagedBody = hostedSource.slice(setManagedIndex, getManagedIndex);

    assertEquals(workflowOperationIndex >= 0, true);
    assertEquals(/const agentName = [^\n]*managed\.activeAgent/.test(activationTail), false);
    assertEquals(/\|\|\s*managed\.activeAgent/.test(activationTail), false);
    assertEquals(/RuntimeEventTypes\.AGENT_CHANGED/.test(activationTail), false);
    assertEquals(setManagedIndex >= 0, true);
    assertEquals(
        /\brootAgentName\b|\bworkflowContext\b|\bactiveThinkingLevel\b|setActiveModelState/.test(setManagedBody),
        false,
    );
});

Deno.test("TUI submission flow does not branch on managed SessionSnapshot projection", async () => {
    const orchestratorSource = await Deno.readTextFile(join(REPO_ROOT, "src/ui/tui/chat-session.ts"));
    const inputSource = await Deno.readTextFile(join(REPO_ROOT, "src/ui/tui/chat-input-controller.ts"));
    const source = `${orchestratorSource}\n${inputSource}`;

    assertEquals(/getRuntimeSnapshot\(\)\.managed\b/.test(source), false);
    assertEquals(/promptManagedSession\s*\(/.test(source), false);
    assertEquals(/promptSession\s*\(sessionId/.test(source), false);
});

Deno.test("SessionRuntime public surface remains adapter-neutral and explicit", () => {
    const methods = Object.getOwnPropertyNames(SessionRuntime.prototype).sort();
    const allowedMethods = [
        "answerInteraction",
        "cancelSession",
        "clearActiveExecutionWorkflow",
        "clearQueuedMessages",
        "closeAllSessions",
        "closeAllSessionsWhenIdle",
        "closeSession",
        "closeSessionWhenIdle",
        "compactSession",
        "constructor",
        "createInteractiveSession",
        "createPromptReadySession",
        "cycleSessionThinkingLevel",
        "dequeueLastQueuedMessage",
        "ensureInitialSessionGeneration",
        "executePlan",
        "expandSessionPromptTemplate",
        "expandSessionSkillCommand",
        "exportSession",
        "getLastAssistantText",
        "getQueuedMessages",
        "getRuntimeActiveAgentName",
        "getRuntimeActiveExecutionWorkflow",
        "getEffectiveAgentName",
        "getSessionBackgroundTaskState",
        "getSessionContextReport",
        "getSessionInfo",
        "getSessionMemoryBackupDir",
        "getSessionProjectRoot",
        "getSessionSnapshot",
        "getUserTurnSubmissionBlockMessage",
        "inspectResumableSession",
        "isManagedSessionDormant",
        "listPlanAssociatedSessions",
        "listResumableSessions",
        "listSessionContextFiles",
        "listSessionPromptTemplates",
        "listSessionSkills",
        "listSessions",
        "loadSession",
        "markPromptReadyAgent",
        "materializePromptReadySession",
        "persistSessionImage",
        "preflightSessionImages",
        "preflightUserTurnImages",
        "promptManagedSession",
        "promptSession",
        "promptUserTurn",
        "queueNextTurnMessage",
        "reconfigureSessionModel",
        "reloadSession",
        "recordPlanAssociation",
        "renameSession",
        "reopenPlanReview",
        "replaceSessionForExecutionFollowUp",
        "replaySession",
        "requestInteraction",
        "requestSessionHelp",
        "retryWorkRecord",
        "reviewSavedPlan",
        "rollManagedSessionSegment",
        "runEpicIntegrationGate",
        "runIsolatedAgent",
        "runLocalShellCommand",
        "runMcpCommand",
        "runPlanAction",
        "runPlanningAgent",
        "runSlicerAgent",
        "runValidation",
        "setActiveExecutionWorkflow",
        "setInteractionAdapter",
        "setProjectStateContext",
        "setSessionAutoCompaction",
        "setSessionModel",
        "setSessionThinkingLevel",
        "steerSession",
        "subscribeSessionEvents",
        "switchAgent",
        "synchronizeManagedSession",
        "takeNextTurnMessage",
        "updateTutorialContext",
        "verifyPlanAssociatedSession",
        "adoptManagedSession",
    ].sort();
    assertEquals(methods, allowedMethods);

    const runtime = createSessionRuntime();
    for (
        const internal of [
            "engine",
            "sessionHost",
            "switchActiveAgent",
            "abortActiveSession",
            "createRootSessionManager",
            "openPersistedRootSession",
            "resolveResumeAgentName",
            "createAgentHandler",
            "ensureRootAgentSession",
            "steerRootSessionWithTarget",
            "eventListeners",
            "turnSettlements",
            "queuedMessages",
            "queueSourceSubscriptions",
            "getHostedSession",
            "getSession",
            "getActivationProof",
            "withSessionManager",
            "attachRuntimeEventSink",
            "emitSessionEvent",
            "recordLocalToolExchange",
            "setSessionHandler",
            "ensureSessionReady",
        ]
    ) {
        assertEquals(Object.hasOwn(runtime, internal), false, `${internal} must remain private`);
        assertEquals(methods.includes(internal), false, `${internal} must not be a public Runtime method`);
    }
});

for (
    const deletedPath of [
        "src/shared/session/presentation-messages.js",
        "src/shared/session/session-runtime-ui.js",
        "src/ui/tui/message-hydration.js",
        "src/ui/tui/task-completed-message.js",
        "src/shared/workflow/code-review.js",
        "src/shared/workflow/review-launcher.js",
        "src/shared/workflow/submit-plan.js",
    ]
) {
    Deno.test(`removed compatibility seam stays deleted: ${deletedPath}`, async () => {
        await assertRejects(() => Deno.stat(join(REPO_ROOT, deletedPath)), Deno.errors.NotFound);
    });
}
