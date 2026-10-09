import { assert, assertEquals, assertRejects } from "@std/assert";
import {
    escapeCancellationScenario,
    fauxProviderProtocolScenario,
    helpSlashCommandScenario,
    initialGoldenScenarios,
    planReviewTransactionContractScenario,
    routerToGuideInquiryScenario,
    runtimeInteractionContractScenario,
    startupNoProvidersOpensLoginScenario,
    startupProviderWithoutModelsOpensModelScenario,
} from "./initial-scenarios.js";
import { GoldenScenarioActor, runGoldenScenario } from "../testing/mod.js";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";

/**
 * Remove the artifact root a failed child retained.
 *
 * These tests provoke child failures on purpose, so the diagnostics they assert
 * on are expected output, not evidence to preserve — left behind, they were the
 * only thing still accumulating in TMPDIR run after run. Removing the heartbeat
 * root rather than `artifactDir` is deliberate: scenario artifacts nest inside
 * it, so the narrower path strands its own parent.
 *
 * @param {unknown} error
 */
async function removeChildHeartbeatArtifact(error) {
    const childPayload =
        /** @type {{ childPayload?: { heartbeatArtifactDir?: unknown } }} */ (error || {}).childPayload;
    const root = childPayload?.heartbeatArtifactDir;
    if (typeof root !== "string" || !root) return;
    await Deno.remove(root, { recursive: true }).catch(() => {});
}

const scenarioExportNames = new Map([
    [routerToGuideInquiryScenario, "routerToGuideInquiryScenario"],
    [escapeCancellationScenario, "escapeCancellationScenario"],
    [helpSlashCommandScenario, "helpSlashCommandScenario"],
    [planReviewTransactionContractScenario, "planReviewTransactionContractScenario"],
    [fauxProviderProtocolScenario, "fauxProviderProtocolScenario"],
    [runtimeInteractionContractScenario, "runtimeInteractionContractScenario"],
    [startupNoProvidersOpensLoginScenario, "startupNoProvidersOpensLoginScenario"],
    [startupProviderWithoutModelsOpensModelScenario, "startupProviderWithoutModelsOpensModelScenario"],
]);

for (const scenario of initialGoldenScenarios.filter((candidate) => candidate !== helpSlashCommandScenario)) {
    Deno.test(`golden scenario: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/initial-scenarios.js",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: "timeoutMs" in scenario && typeof scenario.timeoutMs === "number" ? scenario.timeoutMs : 30000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}

Deno.test("golden actor fails on missing scripted turn", () => {
    const actor = new GoldenScenarioActor([{ id: "guide", agent: "guide", response: "ok" }]);
    assertRejects(
        async () => await Promise.resolve(actor.next({ agent: "router" })),
        Error,
        "Unexpected scripted turn",
    );
});

Deno.test("golden actor fails on unused scripted turn", () => {
    const actor = new GoldenScenarioActor([{ id: "router", agent: "router", response: "ok" }]);
    assertRejects(
        async () => await Promise.resolve(actor.assertComplete()),
        Error,
        "Unused scripted turns",
    );
});

Deno.test("golden runner enforces subprocess isolation for composed scenarios", async () => {
    await assertRejects(
        () => runGoldenScenario({ name: "composed", composedTui: true }, { keepArtifacts: false }),
        Error,
        "subprocess isolation",
    );
});

Deno.test("golden runner reports unknown actions", async () => {
    await assertRejects(
        () => runGoldenScenario({ name: "bad", actions: [{ type: "unknown" }] }, { keepArtifacts: false }),
        Error,
        "Unknown scenario action",
    );
});

Deno.test("golden actor fails on ambiguous scripted turns", async () => {
    const actor = new GoldenScenarioActor([
        { id: "a", agent: "router", response: "a" },
        { id: "b", agent: "router", response: "b" },
    ]);
    await assertRejects(
        async () => await Promise.resolve(actor.next({ agent: "router" })),
        Error,
        "Ambiguous scripted turn",
    );
});

Deno.test("golden actor validates declared available tool set", async () => {
    const actor = new GoldenScenarioActor([
        { id: "router", agent: "router", availableTools: ["triage_report", "read"], response: "ok" },
    ]);
    await assertRejects(
        async () => await Promise.resolve(actor.next({ agent: "router", availableTools: ["triage_report", "write"] })),
        Error,
        "Available tool set mismatch",
    );
});

Deno.test("golden actor fails when required tools are unavailable", () => {
    const actor = new GoldenScenarioActor([
        { id: "router", agent: "router", requiredTools: ["triage_report"], response: "ok" },
    ]);
    assertRejects(
        async () => await Promise.resolve(actor.next({ agent: "router", availableTools: [] })),
        Error,
        "Required tool unavailable",
    );
});

Deno.test("golden scenario child process runs with isolated environment before scenario import", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
    const result = await runGoldenScenarioChildProcess({
        scenarioModule: "src/ui/tui/golden-scenarios/initial-scenarios.js",
        exportName: "helpSlashCommandScenario",
        timeoutMs: 30000,
    });
    assertEquals(result.ok, true);
    assertEquals(result.result.name, "help-slash-command");
    assertEquals(result.result.actor.remaining, []);
    assertEquals(await Deno.stat(result.env.root).then(() => true).catch(() => false), false);
});

Deno.test("golden composition cleans up partial startup failure", async () => {
    const { join } = await import("@std/path");
    const { withProcessGlobalTestLock } = await import("../../../testing/process-global-lock.ts");
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousCwd = Deno.cwd();
        const { createGoldenIsolatedEnvironment } = await import("../testing/isolated-environment.js");
        const { VirtualTerminal } = await import("../testing/virtual-terminal.js");
        const env = await createGoldenIsolatedEnvironment();
        const terminal = new VirtualTerminal();
        try {
            for (const [key, value] of Object.entries(env.env)) Deno.env.set(key, value);
            Deno.chdir(env.projectRoot);
            const { _setTestStatePath } = await import("../../../cmd/init/init-state.ts");
            _setTestStatePath(join(env.runwieldDir, "init-state.json"));
            const { createInteractiveTuiComposition } = await import("../interactive-tui-composition.ts");
            await assertRejects(
                () =>
                    createInteractiveTuiComposition(null, {
                        browser: NO_OPEN_BROWSER_PORT,
                        terminal,
                        skipModelWelcome: true,
                        onSessionReady: () => {
                            throw new Error("forced composition startup failure");
                        },
                    }),
                Error,
                "forced composition startup failure",
            );
            assertEquals(terminal.stopped, true);
        } finally {
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await env.cleanup();
        }
    });
});

Deno.test("golden scenario child process failure reports retained diagnostics artifact", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
    const error = await assertRejects(
        () =>
            runGoldenScenarioChildProcess({
                scenarioModule: "src/ui/tui/golden-scenarios/initial-scenarios.js",
                exportName: "missingGoldenScenario",
                timeoutMs: 3000,
            }),
        Error,
        "artifactDir=",
    );
    const artifactDir = /** @type {Error & { artifactDir?: string }} */ (error).artifactDir;
    assert(artifactDir, "Expected child failure to expose artifactDir on the thrown error.");
    try {
        const diagnostics = await Deno.readTextFile(`${artifactDir}/child-diagnostics.json`);
        assert(diagnostics.includes("missingGoldenScenario"));
    } finally {
        await Deno.remove(artifactDir, { recursive: true }).catch(() => {});
        await removeChildHeartbeatArtifact(error);
    }
});

Deno.test("golden scenario timeout retains child heartbeat diagnostics", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
    const error = await assertRejects(
        () =>
            runGoldenScenarioChildProcess({
                scenarioModule: "src/ui/tui/golden-scenarios/initial-scenarios.js",
                exportName: "timeoutDiagnosticScenario",
                timeoutMs: 2000,
            }),
        Error,
        "timeout",
    );
    const childPayload = /** @type {Error & { childPayload?: { artifactDir?: string } }} */ (error).childPayload;
    const artifactDir = childPayload?.artifactDir;
    assert(artifactDir, "Expected timeout failure to expose child heartbeat artifactDir.");
    try {
        const diagnostics = JSON.parse(await Deno.readTextFile(`${artifactDir}/timeout-diagnostics.json`));
        assert(typeof diagnostics.screenText === "string", "Expected heartbeat screen diagnostics.");
        assert(
            diagnostics.runtime && typeof diagnostics.runtime.activeAgent === "string",
            "Expected heartbeat runtime active-agent diagnostics.",
        );
        assertEquals(diagnostics.actor.remaining, ["timeout-unused-turn"]);
        assert(
            diagnostics.state && typeof diagnostics.state === "object",
            "Expected heartbeat durable state diagnostics.",
        );
    } finally {
        await removeChildHeartbeatArtifact(error);
        const parentArtifactDir = /** @type {Error & { artifactDir?: string }} */ (error).artifactDir;
        if (parentArtifactDir) await Deno.remove(parentArtifactDir, { recursive: true }).catch(() => {});
    }
});

Deno.test("golden scenario child crash surfaces substantive scenario diagnostics", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
    const error = await assertRejects(
        () =>
            runGoldenScenarioChildProcess({
                scenarioModule: "src/ui/tui/golden-scenarios/initial-scenarios.js",
                exportName: "diagnosticArtifactFailureScenario",
                timeoutMs: 10000,
            }),
        Error,
        "childArtifactDir=",
    );
    const childPayload = /** @type {Error & { childPayload?: { artifactDir?: string } }} */ (error).childPayload;
    const artifactDir = childPayload?.artifactDir;
    assert(artifactDir, "Expected child scenario failure to expose scenario artifactDir.");
    try {
        const diagnostics = JSON.parse(await Deno.readTextFile(`${artifactDir}/diagnostics.json`));
        assert(typeof diagnostics.screenText === "string", "Expected screen diagnostics.");
        assert(
            diagnostics.runtime && typeof diagnostics.runtime.activeAgent === "string",
            "Expected runtime active-agent diagnostics.",
        );
        assertEquals(diagnostics.actor.remaining, ["unused-router-turn"]);
        assert(diagnostics.state && typeof diagnostics.state === "object", "Expected durable state diagnostics.");
    } finally {
        await removeChildHeartbeatArtifact(error);
        const parentArtifactDir = /** @type {Error & { artifactDir?: string }} */ (error).artifactDir;
        if (parentArtifactDir) await Deno.remove(parentArtifactDir, { recursive: true }).catch(() => {});
    }
});

Deno.test("golden actor exposes faux-provider response factory integration", () => {
    const actor = new GoldenScenarioActor([
        { id: "guide", agent: "guide", phase: "inquiry", text: "hello", thinking: "thinking" },
    ]);
    const factory = actor.toFauxResponseFactory(() => ({ agent: "guide", phase: "inquiry" }));
    const message = factory({}, {});
    assertEquals(message.role, "assistant");
    actor.assertComplete();
});

Deno.test("golden runner rejects unexpected interactions", async () => {
    await assertRejects(
        () =>
            runGoldenScenario({
                name: "unexpected-interaction",
                interactions: [],
                actions: [{ type: "interaction", interactionType: "PLAN_REVIEW", decision: "approved" }],
            }, { keepArtifacts: false }),
        Error,
        "Unexpected interaction",
    );
});

Deno.test("golden runner writes diagnostic artifacts on failure", async () => {
    const artifactRoot = await Deno.makeTempDir({ prefix: "golden-artifacts-test-" });
    try {
        await assertRejects(
            () => runGoldenScenario({ name: "artifact", actions: [{ type: "unknown" }] }, { artifactRoot }),
            Error,
            "Unknown scenario action",
        );
        const entries = [];
        for await (const entry of Deno.readDir(artifactRoot)) entries.push(entry.name);
        assertEquals(entries.length, 1);
    } finally {
        await Deno.remove(artifactRoot, { recursive: true }).catch(() => {});
    }
});
