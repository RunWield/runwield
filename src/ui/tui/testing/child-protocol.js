/**
 * @module ui/tui/testing/child-protocol
 * Parent/child protocol for subprocess-isolated Golden TUI scenarios.
 */

import { fromFileUrl, join, toFileUrl } from "@std/path";
import { createGoldenIsolatedEnvironment } from "./isolated-environment.js";
import { GOLDEN_CHILD_READY_MARKER, runGoldenChild } from "./subprocess-runner.js";
import { releaseProcessGlobalTestLockSync } from "../../../testing/process-global-lock.ts";

const CHILD_FLAG = "--golden-tui-child";

/**
 * Deno runs test modules concurrently inside one process, so `Deno.cwd()` is
 * shared mutable state that any other test file may chdir out from under us
 * mid-call. Anchor repository-relative scenario modules to this file instead.
 */
const REPO_ROOT = fromFileUrl(new URL("../../../..", import.meta.url));

/**
 * @typedef {Object} GoldenChildScenarioRequest
 * @property {string} scenarioModule
 * @property {string} exportName
 * @property {number} [timeoutMs]
 * @property {boolean} [keepArtifacts]
 * @property {boolean} [initDone]
 * @property {boolean} [initArtifact]
 */

/** @param {string} stdout */
function parseLastJsonLine(stdout) {
    const line = stdout.trim().split("\n").toReversed().find((candidate) => candidate.includes("{"));
    if (!line) return null;
    try {
        return JSON.parse(line.slice(line.indexOf("{")));
    } catch {
        return null;
    }
}

/**
 * @param {GoldenChildScenarioRequest} request
 * @param {import('./subprocess-runner.js').GoldenChildResult} result
 * @param {unknown} childPayload
 */
async function writeChildFailureArtifact(request, result, childPayload) {
    const artifactDir = await Deno.makeTempDir({ prefix: "runwield-golden-tui-child-failure-" });
    await Deno.writeTextFile(
        join(artifactDir, "child-diagnostics.json"),
        JSON.stringify(
            {
                scenarioModule: request.scenarioModule,
                exportName: request.exportName,
                timedOut: result.timedOut,
                code: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
                childPayload,
            },
            null,
            2,
        ),
    );
    return artifactDir;
}

/**
 * Remove the isolated environment a child reported on startup. Safe to call on
 * every outcome: a child that cleaned up after itself leaves nothing to find.
 *
 * @param {unknown} childPayload
 */
async function removeChildEnvironmentRoot(childPayload) {
    if (!childPayload || typeof childPayload !== "object") return;
    const env = /** @type {{ env?: unknown }} */ (childPayload).env;
    if (!env || typeof env !== "object") return;
    const root = /** @type {{ root?: unknown }} */ (env).root;
    if (typeof root !== "string" || !root) return;
    await Deno.remove(root, { recursive: true }).catch(() => {});
}

/**
 * Runs a scenario in a fresh Deno process. The child creates HOME/Project/Git,
 * model/settings, worktree, and registry directories before importing the
 * scenario module or other RunWield code.
 *
 * @param {GoldenChildScenarioRequest} request
 */
export async function runGoldenScenarioChildProcess(request) {
    const normalizedRequest = {
        ...request,
        scenarioModule: request.scenarioModule.startsWith("file:")
            ? request.scenarioModule
            : toFileUrl(join(REPO_ROOT, request.scenarioModule)).href,
    };
    const payload = JSON.stringify(normalizedRequest);
    // `--no-check`: the child re-executes code the parent test file already ran
    // under `--no-check`; type-checking it again resolves deno.json's whole
    // `compilerOptions.types` graph, and the `"vite/client"` entry pulls
    // npm:vite + dependencies — a large registry download on cold caches that
    // stalls scenario startup. The repo type gate is `deno task check`.
    const result = await runGoldenChild([
        "run",
        "-A",
        "--no-check",
        // The sandboxed test runner prepares dependencies before any test runs.
        // Keep a fresh process, but reuse that installation for every journey.
        "--node-modules-dir=manual",
        fromFileUrl(import.meta.url),
        CHILD_FLAG,
        payload,
    ], { cwd: REPO_ROOT, timeoutMs: request.timeoutMs || 5000, awaitReadyMarker: true });
    const childPayload = parseLastJsonLine(result.stdout);
    // A scenario that declares `expectedCleanExit` terminates the child through
    // the real `/quit` (`Deno.exit(0)`) before its post-composition result is
    // printed; the pre-exit report it logged is the terminal success signal, and
    // the child's exit code 0 is the proof the quit path ran for real.
    const expectedCleanExit = childPayload && typeof childPayload === "object" &&
        /** @type {{ expectedCleanExit?: unknown }} */ (childPayload).expectedCleanExit === true;
    // Backstop for a child that never got to tear itself down: one wedged past
    // the grace window, or crashed before its own cleanup. The child announces
    // its environment root on startup precisely so this path can find it.
    if (!request.keepArtifacts) await removeChildEnvironmentRoot(childPayload);
    const childReportedFailure = childPayload && typeof childPayload === "object" && "ok" in childPayload &&
        !/** @type {{ ok?: unknown }} */ (childPayload).ok;
    // A success report does not excuse a hung process or unfinished teardown.
    // The scenario must both satisfy its assertions and exit successfully.
    if (childReportedFailure || !result.success || result.timedOut) {
        const artifactDir = await writeChildFailureArtifact(normalizedRequest, result, childPayload);
        const childArtifact = childPayload && typeof childPayload === "object" && "artifactDir" in childPayload
            ? `; childArtifactDir=${String(/** @type {{ artifactDir?: unknown }} */ (childPayload).artifactDir || "")}`
            : "";
        // The child's own `error` is the unmet expectation; stderr is whatever the
        // composed TUI happened to warn about on the way (a theme notice, say).
        // Reporting stderr first buried every real failure behind unrelated noise.
        const childError = childPayload && typeof childPayload === "object" && "error" in childPayload
            ? String(/** @type {{ error?: unknown }} */ (childPayload).error || "")
            : "";
        const error = new Error(
            `Golden child failed${result.timedOut ? " (timeout)" : ""}; artifactDir=${artifactDir}${childArtifact}: ${
                childError || result.stderr || result.stdout
            }`,
        );
        /** @type {Error & { artifactDir?: string, childPayload?: unknown }} */ (error).artifactDir = artifactDir;
        /** @type {Error & { artifactDir?: string, childPayload?: unknown }} */ (error).childPayload = childPayload;
        throw error;
    }
    if (expectedCleanExit) {
        // The child could not clean up after itself (Deno.exit skips its finally
        // blocks); reclaim its heartbeat artifact root here.
        const heartbeatArtifactDir = typeof childPayload === "object" && childPayload !== null &&
                "heartbeatArtifactDir" in childPayload
            ? /** @type {{ heartbeatArtifactDir?: unknown }} */ (childPayload).heartbeatArtifactDir
            : null;
        if (!request.keepArtifacts && typeof heartbeatArtifactDir === "string") {
            await Deno.remove(heartbeatArtifactDir, { recursive: true }).catch(() => {});
        }
        // Run the scenario's own assertions against the pre-exit report; the
        // child that produced it is already gone.
        const module = await import(normalizedRequest.scenarioModule);
        const scenario = module[normalizedRequest.exportName];
        if (!scenario) throw new Error(`Missing scenario export: ${normalizedRequest.exportName}`);
        const report = /** @type {{ result?: unknown }} */ (childPayload).result;
        if (!report || typeof report !== "object") {
            throw new Error("Expected-clean-exit scenario did not report a pre-exit result.");
        }
        for (const assertion of scenario.assertions || []) {
            await assertion(/** @type {any} */ (report));
        }
    }
    return childPayload || {};
}

/** @param {GoldenChildScenarioRequest} request */
async function runChild(request) {
    const env = await createGoldenIsolatedEnvironment({
        keep: request.keepArtifacts,
        initDone: request.initDone,
        initArtifact: request.initArtifact,
    });
    const timeoutArtifactDir = await Deno.makeTempDir({ prefix: "runwield-golden-tui-timeout-" });
    await Deno.writeTextFile(
        join(timeoutArtifactDir, "timeout-diagnostics.json"),
        JSON.stringify(
            {
                scenario: request.exportName,
                screenText: "",
                scrollback: "",
                events: [],
                state: {},
                actor: { consumed: [], remaining: [] },
                runtime: { activeAgent: "startup" },
                cwd: env.projectRoot,
                home: env.home,
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify({
        ok: false,
        heartbeat: true,
        artifactDir: timeoutArtifactDir,
        heartbeatArtifactDir: timeoutArtifactDir,
        env: { root: env.root, projectRoot: env.projectRoot },
    }));
    // The runner signals a timed-out child rather than killing it outright, so
    // this handler is the only chance to reclaim the isolated environment. Deno
    // signal handlers run synchronously, so unlink synchronously instead of
    // awaiting env.cleanup(). timeoutArtifactDir is deliberately left in place:
    // retaining it is the entire point of a timeout.
    const handleTermination = () => {
        if (!request.keepArtifacts) {
            try {
                Deno.removeSync(env.root, { recursive: true });
            } catch {
                // Best effort; the parent sweeps the environment as a backstop.
            }
        }
        // Composed scenarios run under the process-global test lock, and exiting
        // here skips the release in its `finally`.
        releaseProcessGlobalTestLockSync();
        Deno.exit(143);
    };
    Deno.addSignalListener("SIGTERM", handleTermination);
    try {
        for (const [key, value] of Object.entries(env.env)) Deno.env.set(key, value);
        Deno.chdir(env.projectRoot);
        Deno.env.set("WLD_GOLDEN_TUI_CHILD", "1");
        await Deno.writeTextFile(join(timeoutArtifactDir, "startup-phase.txt"), "loading init state\n");
        const { _setTestStatePath } = await import("../../../cmd/init/init-state.ts");
        _setTestStatePath(join(env.runwieldDir, "init-state.json"));
        await Deno.writeTextFile(join(timeoutArtifactDir, "startup-phase.txt"), "loading scenario runner\n");
        const { runGoldenScenario } = await import("./scenario-runner.js");
        const moduleUrl = request.scenarioModule.startsWith("file:")
            ? request.scenarioModule
            : toFileUrl(join(REPO_ROOT, request.scenarioModule)).href;
        await Deno.writeTextFile(join(timeoutArtifactDir, "startup-phase.txt"), "loading scenario\n");
        const module = await import(moduleUrl);
        const scenario = module[request.exportName];
        if (!scenario) throw new Error(`Missing scenario export: ${request.exportName}`);
        try {
            await Deno.writeTextFile(join(timeoutArtifactDir, "startup-phase.txt"), "starting scenario\n");
            const result = await runGoldenScenario(scenario, {
                keepArtifacts: request.keepArtifacts,
                artifactRoot: timeoutArtifactDir,
                heartbeatPath: join(timeoutArtifactDir, "timeout-diagnostics.json"),
                onReady: () => console.log(GOLDEN_CHILD_READY_MARKER),
            });
            await Deno.remove(timeoutArtifactDir, { recursive: true }).catch(() => {});
            console.log(JSON.stringify({ ok: true, result, env: { root: env.root, projectRoot: env.projectRoot } }));
        } catch (error) {
            console.log(JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                artifactDir: /** @type {{ artifactDir?: unknown }} */ (error || {}).artifactDir || null,
                // Scenario artifacts nest inside this directory, so it is the root a
                // caller has to remove to reclaim everything the run retained.
                // `artifactDir` alone names a child of it and leaves the parent behind.
                heartbeatArtifactDir: timeoutArtifactDir,
                env: { root: env.root, projectRoot: env.projectRoot },
            }));
            Deno.exitCode = 1;
            return;
        }
    } finally {
        // A registered signal listener holds the event loop open, so this has to
        // come off before the child can exit on its own.
        Deno.removeSignalListener("SIGTERM", handleTermination);
        await env.cleanup();
    }
}

if (import.meta.main && Deno.args[0] === CHILD_FLAG) {
    const request = JSON.parse(Deno.args[1] || "{}");
    await runChild(request);
}
