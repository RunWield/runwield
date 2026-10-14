import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    collectConditionalSeamKeys,
    collectConditionalSeams,
    collectSeamNames,
    collectSeams,
    findRegressions,
    isMachinerySeam,
} from "./check-injection-seams.js";

test("collectSeams scans production source and scripts but excludes tests", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-seam-scan-roots-"));
    try {
        const sourceRoot = new URL(`file://${root}/src/`);
        const scriptsRoot = new URL(`file://${root}/scripts/`);
        await fsMkdir(sourceRoot, { recursive: true });
        await fsMkdir(scriptsRoot, { recursive: true });
        await fsWriteFile(new URL("command.ts", sourceRoot), "const run = deps.run || systemRun; run();\n");
        await fsWriteFile(new URL("release.js", scriptsRoot), "const run = deps.run || systemRun; run();\n");
        await fsWriteFile(new URL("release.test.js", scriptsRoot), "const run = deps.run || systemRun; run();\n");

        const seams = await collectSeams([
            { rootUrl: sourceRoot, pathPrefix: "src" },
            { rootUrl: scriptsRoot, pathPrefix: "scripts" },
        ]);
        assertEquals(Object.keys(seams).sort(), ["scripts/release.js", "src/command.ts"]);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

/** @param {string[]} lines */
function conditionalLines(...lines) {
    return collectConditionalSeams(lines.join("\n")).map((offender) => offender.split(" ")[1]);
}

test("collectSeamNames reads member access and destructured bags", () => {
    const source = [
        "const a = __deps?.runLocalCI || runLocalCI;",
        "const b = __deps.recordPlanEvent;",
        "const { switchActiveAgent, runRootTurn: turn } = __testDeps;",
        "const { loadPlan } = options.__deps;",
    ].join("\n");

    assertEquals(collectSeamNames(source), [
        "loadPlan",
        "recordPlanEvent",
        "runLocalCI",
        "runRootTurn",
        "switchActiveAgent",
    ]);
});

test("machinery seam patterns match wildcards in the middle of transaction names", () => {
    assertEquals(isMachinerySeam("runImplementationCheckpointTransition"), true);
    assertEquals(isMachinerySeam("runTransition"), true);
    assertEquals(isMachinerySeam("runImplementationCheckpoint"), false);
    assertEquals(isMachinerySeam("_buildAgentSession"), true);
    assertEquals(isMachinerySeam("_attachSessionEventSubscribers"), true);
    assertEquals(isMachinerySeam("_runPrompt"), true);
    assertEquals(isMachinerySeam("_agentDefOverride"), true);
});

test("collectSeamNames catches arbitrary Agent Definition overrides", () => {
    assertEquals(
        collectSeamNames(`
            async function build(opts) {
                const agentDef = opts._agentDefOverride || await loadAgentDef(opts.agentName);
                return agentDef;
            }
        `),
        ["_agentDefOverride"],
    );
});

// One line of indirection used to hide an entire bag, machinery included.
test("collectSeamNames follows a bag aliased to a local name", () => {
    const source = [
        "const deps = __deps || {};",
        "const value = deps.recordPlanEvent;",
        "await deps?.requestPlanReview();",
        "const other = notDeps.ignored;",
    ].join("\n");

    assertEquals(collectSeamNames(source), ["recordPlanEvent", "requestPlanReview"]);
});

test("collectSeamNames rejects optional fallback bags renamed to ports", () => {
    const names = collectSeamNames(`
        export function run({ ports = {} }) {
            const transition = ports.runPlanTransition || runPlanTransition;
            const load = ports.loadPlan || loadPlan;
            return transition(load);
        }
        export function resume(ports) {
            return (ports?.runActiveAgentTurn || runActiveAgentTurn)();
        }
    `);

    assertEquals(names, ["loadPlan", "runActiveAgentTurn", "runPlanTransition"]);
});

test("collectSeamNames leaves required capability ports alone", () => {
    const names = collectSeamNames(`
        interface LocalCIPort { run(cwd: string): Promise<number>; }
        export function validate(localCI: LocalCIPort, cwd: string) {
            return localCI.run(cwd);
        }
    `);

    assertEquals(names, []);
});

test("collectConditionalSeams flags a seam gated on the bag itself", () => {
    assertEquals(
        conditionalLines(
            "const settle = __deps",
            "    ? (() => Promise.resolve(null))",
            "    : settleWorktreeAttempt;",
        ),
        ["2"],
    );
});

test("collectConditionalSeams flags a seam gated on a different dep", () => {
    assertEquals(
        conditionalLines("const head = __deps?.mergeExecutionWorktree ? fakeHead : getBranchHead;"),
        ["1"],
    );
});

// The shape that sat live in workflow.js under a green ratchet: the `__deps` reads are
// behind an `&&` and a paren, so nothing is adjacent to the `?`. Adjacency matching is
// why it was missed, so this is the case that must stay covered.
test("collectConditionalSeams flags a condition whose deps are not adjacent to the ?", () => {
    assertEquals(
        conditionalLines(
            "const settle = __deps?.settleWorktreeAttempt ||",
            "    ((__deps?.createWorktreeGitArtifacts && __deps?.updateWorktreeRegistryEntry)",
            "        ? ((_, worktree) => Promise.resolve(worktree))",
            "        : settleWorktreeAttempt);",
        ),
        ["3"],
    );
});

test("collectConditionalSeams flags a branch on an injected value compared to a literal", () => {
    assertEquals(
        conditionalLines('const run = __deps?.mode === "fake" ? fakeRun : runLocalCI;'),
        ["1"],
    );
});

test("collectConditionalSeams cannot be defeated by renaming the bag", () => {
    assertEquals(
        conditionalLines(
            "function choose(dependencies = {}) {",
            "const turn = dependencies?.runRootTurn",
            "    ? fakeTurn",
            "    : runRootTurn; }",
        ),
        ["3"],
    );
});

test("conditional seam keys are stable by collaborator and preserve repeated branches", () => {
    assertEquals(
        collectConditionalSeamKeys(`
            function choose(deps = {}) {
                const first = deps.now ? deps.now() : Date.now();
                const second = deps.now ? deps.now() : Date.now();
                const setting = deps.settings !== undefined ? deps.settings : deps.getSetting();
            }
        `),
        ["members:now", "members:now", "members:settings"],
    );
});

test("conditional seam keys identify direct and multi-member bag gates", () => {
    assertEquals(
        collectConditionalSeamKeys(`
            const first = __deps ? fake : real;
            const second = (__deps?.createWorktree && __deps?.updateRegistry) ? fake : real;
        `),
        ["bags:__deps", "members:createWorktree+updateRegistry"],
    );
});

test("collectConditionalSeams ignores unconditional seams and non-ternary question marks", () => {
    assertEquals(
        conditionalLines(
            "const a = __deps?.runLocalCI || runLocalCI;",
            "const b = __deps?.now ?? (() => Date.now());",
            "const c = __deps?.git?.isAncestor;",
            "const d = ready ? runLocalCI : skip;",
        ),
        [],
    );
});

// The bags are documented in JSDoc as `__deps?: { … }`, which is indistinguishable from a
// ternary to a text scan. A false positive here would make the rule unusable.
test("collectConditionalSeams ignores optional syntax in comments and type positions", () => {
    assertEquals(
        conditionalLines(
            "/**",
            " * @param {{ __deps?: { runLocalCI?: typeof runLocalCI } }} opts",
            " */",
            "export function run(opts, __deps?: Deps) {",
            "    return opts.value;",
            "}",
        ),
        [],
    );
});

test("collectSeamNames follows a renamed destructure off an aliased bag", () => {
    // The shape load-plan/index.js uses. The bag is reached through a local alias and
    // then destructured with every binding renamed, which hid 38 names — ten of them
    // machinery — behind a green ratchet.
    const names = collectSeamNames(`
        export async function runLoadPlanCommand(argv, options = {}) {
            const deps = (options).__testDeps || {};
            const {
                recordPlanEvent: recordPlanEventDep,
                mergeExecutionWorktree: mergeExecutionWorktreeDep,
                parseArgs: parseArgsDep,
            } = deps;
        }
    `);
    assertEquals(names, ["mergeExecutionWorktree", "parseArgs", "recordPlanEvent"]);
});

test("collectSeamNames follows an aliased bag declared through a type cast", () => {
    // The cast is a comment, so the initializer is mostly whitespace by the time this
    // scan sees it. The alias still has to be recognised.
    const names = collectSeamNames(`
        const deps = /** @type {LoadPlanTestDeps} */ ((/** @type {any} */ (options)).__testDeps || {});
        const { savePlan: savePlanDep } = deps;
    `);
    assertEquals(names, ["savePlan"]);
});

test("collectSeamNames does not treat a value read out of the bag as another bag", () => {
    // `runLocalCI` is the seam; `result` is its return value. Counting `result.exitCode`
    // would invent a seam that nothing injects.
    const names = collectSeamNames(`
        const runLocalCI = __deps.runLocalCI || runLocalCIImpl;
        const result = __deps.runLocalCI ? await runLocalCI() : null;
        if (result.exitCode === 0) return;
    `);
    assertEquals(names, ["runLocalCI"]);
});

test("collectSeamNames does not alias the result of a call that receives the bag", () => {
    // `loadSlicerAgentDef(__deps)` returns an agent definition, not the bag. Treating it
    // as one counted `displayName` as a seam that nothing injects.
    const names = collectSeamNames(`
        const loadEpic = __deps?.loadPlan || loadPlan;
        const slicerAgentDef = await loadSlicerAgentDef(__deps);
        const slicerDisplay = slicerAgentDef.displayName;
    `);
    assertEquals(names, ["loadPlan"]);
});

test("collectSeamNames follows a bag handed over as a typed parameter", () => {
    // Splitting a command into modules passes the bag on as an ordinary argument, and
    // the reads travel with it. Counting only bags literally named `__deps` let four
    // seams leave load-plan/index.js and stop being counted anywhere at all.
    const names = collectSeamNames(`
        interface PlanSessionSurfaceDeps {
            executePlan?: (options: unknown) => Promise<unknown>;
            runPlanningAgent?: (options: unknown) => Promise<unknown>;
        }
        export function createSurface(runtime: Runtime, deps: PlanSessionSurfaceDeps) {
            return {
                executePlan: (options) => deps.executePlan ? deps.executePlan(options) : runtime.executePlan(options),
                runPlanningAgent: (options) => deps.runPlanningAgent?.(options),
            };
        }
    `);
    assertEquals(names, ["executePlan", "runPlanningAgent"]);
});

test("collectSeamNames leaves required dependencies alone", () => {
    // A type whose members are required is constructor injection, not an override bag:
    // the caller must supply them, so nothing is being swapped out from underneath.
    // That is the shape this check tells people to move to, and flagging it would
    // punish the fix.
    const names = collectSeamNames(`
        interface TuiManagerDeps {
            TerminalCtor: TerminalConstructor;
            installCrashGuards(): void;
            restoreTitle?: () => void;
        }
        export function createTuiManager(deps: TuiManagerDeps) {
            const { TerminalCtor, installCrashGuards, restoreTitle = defaultRestoreTitle } = deps;
            return { TerminalCtor, installCrashGuards, restoreTitle };
        }
    `);
    assertEquals(names, []);
});

test("collectSeamNames does not read a bag name out of a module specifier", () => {
    // `deps` occurs inside "./load-plan-test-deps.ts". Matching it there invented a
    // seam called `ts` — a file extension, not anything injected.
    const names = collectSeamNames(`
        import type { LoadPlanTestDeps } from "./load-plan-test-deps.ts";
        const deps = __testDeps || {};
        const loadPlan = deps.loadPlan || loadPlanFn;
    `);
    assertEquals(names, ["loadPlan"]);
});

test("collectSeamNames follows a bag through a merge helper", () => {
    // The bag is merged into an all-required shape before use, so the parameter type
    // is not itself optional. The file names `__deps`, which settles it: what travels
    // through the helper is the bag, and the reads on the far side are seams.
    const names = collectSeamNames(`
        interface NotifierDeps { env?: Env; writeTerminal?: (bytes: Uint8Array) => void; }
        interface RequiredNotifierDeps { env: Env; writeTerminal: (bytes: Uint8Array) => void; }
        interface Options { __deps?: NotifierDeps; }
        function emit(deps: RequiredNotifierDeps) {
            deps.writeTerminal(BELL);
            return deps.env.TERM;
        }
    `);
    assertEquals(names, ["env", "writeTerminal"]);
});

test("collectSeamNames follows optional bags named deps or dependencies", () => {
    const names = collectSeamNames(`
        export function switchAgent(options, dependencies = {}) {
            const build = dependencies.ensureRootAgentSession || ensureRootAgentSession;
            return build(options);
        }
        export function record(metric, deps = {}) {
            return (deps.writeTextFile || Deno.writeTextFile)(deps.path, metric);
        }
    `);

    assertEquals(names, ["ensureRootAgentSession", "path", "writeTextFile"]);
});

test("collectSeamNames detects fallbacks hidden in ordinary options and nested singular ports", () => {
    const names = collectSeamNames(`
        export function createRuntime(options = {}) {
            const switchAgent = options.switchActiveAgent || switchActiveAgent;
            const build = options._buildAgentSession || buildAgentSession;
            const buildExecution = options._buildAgentSession || buildExecutionSession;
            return { switchAgent, build, buildExecution };
        }
        export function review(args) {
            const run = args.semanticReviewPort?.runIsolatedAgentSession || runIsolatedAgentSession;
            const diff = args.semanticReviewPort?.getDiffText;
            return diff ? diff() : run();
        }
        export function recover({
            recordWorkflowMetric: recordWorkflowMetricImpl = recordWorkflowMetric,
            finalizePlanImplementation = finalizePlanImplementationFn,
        }) {}
    `);

    assertEquals(names, [
        "_buildAgentSession",
        "finalizePlanImplementation",
        "getDiffText",
        "recordWorkflowMetric",
        "runIsolatedAgentSession",
        "switchActiveAgent",
    ]);
});

test("collectSeamNames detects a buildAgentSession override masking buildExecutionSession", () => {
    const names = collectSeamNames(`
        export function build(options) {
            return options._buildAgentSession || buildExecutionSession;
        }
    `);

    assertEquals(names, ["_buildAgentSession"]);
});

test("collectSeamNames detects mutable dependency registries and individual test override hooks", () => {
    const names = collectSeamNames(`
        const defaultClipboardDeps = { Command, remove };
        let clipboardDeps = defaultClipboardDeps;
        let binaryProbeOverride = null;
        export function read() {
            return new clipboardDeps.Command();
        }
        export function __setClipboardDepsForTest(deps = {}) {
            clipboardDeps = { ...defaultClipboardDeps, ...deps };
        }
        export function __resetRuntimePreflightForTest(probe = null) {
            binaryProbeOverride = probe;
        }
    `);

    assertEquals(names, ["Command", "binaryProbeOverride"]);
});

test("collectSeamNames detects explicitly test-named option members", () => {
    assertEquals(
        collectSeamNames(`
            export function ensureIdentity(options = {}) {
                const idGenerator = options.idGenerator || options.__testGenerateId || crypto.randomUUID;
                return idGenerator();
            }
        `),
        ["__testGenerateId"],
    );
});

test("collectSeamNames detects required RunWield machinery in option shapes", () => {
    const names = collectSeamNames(`
        export interface RecoveryOptions {
            recordPlanEvent: typeof recordPlanEvent;
            updateWorktreeRegistryEntry: typeof updateWorktreeRegistryEntry;
            runValidationTransition: typeof runValidationTransition;
            commandOutput: CommandPort;
        }
    `);

    assertEquals(names, ["recordPlanEvent", "runValidationTransition", "updateWorktreeRegistryEntry"]);
});

test("collectSeamNames ignores data overrides and required external ports without fallbacks", () => {
    const names = collectSeamNames(`
        export function injectFrontMatter(markdown, overrides = {}) {
            return { ...markdown, ...overrides };
        }
        export function resolveData(resource, attrs, options) {
            const planId = resource.planId || attrs.planId;
            const cwd = options.cwd || project.cwd;
            return { planId, cwd };
        }
        export function format(details: Details | null = null, length = source.length) {
            const missing = details?.missingDependencies?.length || 0;
            return { details, length, missing };
        }
        interface BrowserPort { open(url: string): Promise<void>; }
        export function show(port: BrowserPort, url: string) {
            return port.open(url);
        }
    `);

    assertEquals(names, []);
});

test("collectSeamNames leaves a required imported singular capability port alone", () => {
    const names = collectSeamNames(`
        import type { BrowserPort } from "./browser-port.ts";
        interface ReviewOptions {
            browser: BrowserPort;
        }
        export function show({ browser }: ReviewOptions, url: string) {
            return browser.open(url);
        }
    `);

    assertEquals(names, []);
});

test("collectSeamNames detects a parameter default bound to a differently-named implementation", () => {
    // The same-name test was the whole rule for a while, which made "give the
    // implementation another name" a working way to leave this scan without changing a
    // line of behavior. Both of these were live in the tree under a green ratchet.
    const names = collectSeamNames(`
        export function attachTuiRuntimeAdapter({
            runtime,
            sessionId,
            notifyRunWieldEvent = notifyRunWieldEventQuietly,
        }) {
            return notifyRunWieldEvent(runtime, sessionId);
        }
        export async function applyTransition(
            { projectRoot, planName, recordMetric = recordWorkflowMetric }: TransitionOptions,
        ) {
            await recordMetric({ projectRoot, planName });
        }
    `);

    assertEquals(names, ["notifyRunWieldEvent", "recordMetric"]);
});

test("collectSeamNames flags machinery behind a default however the implementation is named", () => {
    // A machinery name is a seam whatever it defaults to: the different-name rule is a
    // heuristic, but "RunWield transactions must not be replaceable" is not.
    const names = collectSeamNames(`
        export function repair(planName, finalizePlanImplementation = commitTheWholeThing) {
            return finalizePlanImplementation(planName);
        }
    `);

    assertEquals(names, ["finalizePlanImplementation"]);
});

test("collectSeamNames leaves a convenience default on an already-required dependency alone", () => {
    // Unpacking a required deps parameter is constructor injection — the shape this
    // check tells people to migrate *to*. Whether the destructure ends in a trailing
    // comma must not decide it, which is why the rule is scoped by position rather than
    // by which pattern happened to match first.
    const names = collectSeamNames(`
        interface TuiManagerDeps {
            TerminalCtor: TerminalConstructor;
            installCrashGuards(): void;
            restoreTitle?: () => void;
        }
        export function createTuiManager(deps: TuiManagerDeps) {
            const {
                TerminalCtor,
                installCrashGuards,
                restoreTitle = defaultRestoreTitle,
            } = deps;
            return { TerminalCtor, installCrashGuards, restoreTitle };
        }
    `);

    assertEquals(names, []);
});

test("collectSeamNames does not mistake a type annotation or a comparison for an injected default", () => {
    // `log: CommandLog = console.log` once reported `CommandLog` — a type name, not
    // anything injectable — because the annotation was parsed as the parameter name and
    // capitalized names read as behavioral. `>=` split the same way once the annotation
    // group could span it, inventing a seam out of an array-length check.
    const names = collectSeamNames(`
        type CommandLog = (message?: string) => void;
        export function runInstall(
            args: string[],
            log: CommandLog = console.log,
            localCI: LocalCIPort = systemLocalCIPort,
        ) {
            return { args, log, localCI };
        }
        export function projectWindow(events, startIndex, selected) {
            return {
                complete: startIndex + selected.length >= events.length,
            };
        }
    `);

    assertEquals(names, []);
});

test("collectSeamNames detects optional capability properties with production fallbacks", () => {
    const names = collectSeamNames(`
        const localCI = args.localCI || systemLocalCIPort;
        await localCI.run({ cwd });
        const gitPort = args.git || createGitPort();
        await gitPort.captureTree(cwd);
        await (options.browser || SYSTEM_BROWSER_PORT).open(url);
        const registry = options.commandRegistry || defaultCommandRegistry;
        registry.resolve(commandName);
    `);

    assertEquals(names, ["browser", "commandRegistry", "git", "localCI"]);
});

test("collectSeamNames leaves behavioral flags combined with payload data alone", () => {
    assertEquals(
        collectSeamNames(`
            function applyRevision(options) {
                if (options.clearAttachedContext || initialPayload.standaloneReview) {
                    setAnnotations([]);
                }
            }
        `),
        [],
    );
});

test("collectSeamNames detects behavioral member implementations in ordinary options", () => {
    assertEquals(
        collectSeamNames(`
            const read = options.readTextFile || Deno.readTextFile;
            const clear = options.clearAttachedContext || context.clear;
            read(path);
            clear();
        `),
        ["clearAttachedContext", "readTextFile"],
    );
});

test("collectSeamNames leaves ordinary optional data fallbacks alone", () => {
    const names = collectSeamNames(`
        const interval = options.interval || DEFAULT_POLL_INTERVAL_MS;
        const frontMatter = options.frontMatter || DEFAULT_FRONT_MATTER;
        const title = options.title || defaultTitle;
        const registry = options.registry || new Map();
        registry.set("name", title);
    `);

    assertEquals(names, []);
});

test("collectSeamNames detects behavioral callbacks that fall back to an inline no-op", () => {
    assertEquals(
        collectSeamNames(`
            const setActiveModel = options.setActiveModel || (() => {});
            const title = options.title || (() => {});
        `),
        ["setActiveModel"],
    );
});

test("collectSeamNames detects invoked callback options with inline implementations", () => {
    assertEquals(
        collectSeamNames(`
            const generateSections = options.generateSections ||
                ((source) => generateRecorderSections(cwd, source, options));
            const sections = await generateSections(source);
        `),
        ["generateSections"],
    );
});

test("collectSeamNames detects invoked concrete collaborators with constructor fallbacks", () => {
    assertEquals(
        collectSeamNames(`
            const runtime = options.runtime || new SessionRuntime();
            const sessionMap = options.sessionMap || new AcpSessionMap();
            await runtime.createPromptReadySession({ cwd });
            sessionMap.createRecord({ sessionId, cwd });
        `),
        ["runtime", "sessionMap"],
    );
});

test("collectSeamNames detects constructor fallbacks assigned to instance fields", () => {
    assertEquals(
        collectSeamNames(`
            class Runtime {
                constructor(options = {}) {
                    this.#sessionHost = options.sessionHost || new SessionHost();
                }
                list() { return this.#sessionHost.listSessions(); }
            }
        `),
        ["sessionHost"],
    );
});

test("collectSeamNames detects behavioral object properties with differently named implementations", () => {
    assertEquals(
        collectSeamNames(`
            const state = {
                runGuideCommand: options.runGuideCommand || runConfiguredGuideCommand,
            };
        `),
        ["runGuideCommand"],
    );
});

test("collectSeamNames does not mistake boolean expressions or constructors for behavioral fallbacks", () => {
    assertEquals(
        collectSeamNames(`
            const selectable = RuntimeInteractionTypes.SELECT || interaction.type === RuntimeInteractionTypes.APPROVAL;
            const now = options.now || new Date().toISOString();
            if (uiAPI.startToolExecution || HIDDEN_TOOL_BLOCK_NAMES.has(toolName)) return;
        `),
        [],
    );
});

test("collectSeamNames detects replacement hooks whose descriptive name ends in Tests", () => {
    assertEquals(
        collectSeamNames(`
            let getSettingsManagerForPersistence = getSettingsManager;
            export function __setSettingsManagerForPersistenceTests(provider) {
                getSettingsManagerForPersistence = provider || getSettingsManager;
            }
        `),
        ["getSettingsManagerForPersistence"],
    );
});

test("findRegressions rejects newly visible seams inside a known module by default", () => {
    const baseline = {
        "src/known.ts": { seams: ["existing"], machinery: [], conditional: [] },
    };
    const current = {
        "src/known.ts": { seams: ["existing", "newlyVisible"], machinery: [], conditional: [] },
    };

    assertEquals(findRegressions(current, baseline), [
        "src/known.ts: new injection seam(s): newlyVisible.",
    ]);
});

test("findRegressions explicitly adopts newly visible modules and seams in known modules", () => {
    const baseline = {
        "src/known.ts": { seams: ["existing"], machinery: [], conditional: [] },
    };
    const current = {
        "src/known.ts": {
            seams: ["existing", "newlyVisible"],
            machinery: ["newlyVisible"],
            conditional: ["members:newlyVisible"],
        },
        "src/new.ts": { seams: ["externalPort"], machinery: [], conditional: [] },
    };

    assertEquals(findRegressions(current, baseline, true), []);
});
