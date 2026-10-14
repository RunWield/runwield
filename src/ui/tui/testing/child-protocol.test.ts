import { test } from "node:test";
import { mkdtemp as fsMkdtemp, rm as fsRm, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../../testing/assertions.ts";
import { join } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";
import { runGoldenScenarioChildProcess } from "./child-protocol.js";
import { GOLDEN_CHILD_READY_MARKER } from "./subprocess-runner.js";

test("Golden scenarios reject a timeout even after the child reports success", async () => {
    const fixtureRoot = await fsMkdtemp(join(tmpdir(), "golden-success-then-hang-"));
    const scenarioPath = join(fixtureRoot, "hanging-scenario.ts");
    try {
        await fsWriteFile(
            scenarioPath,
            [
                `console.log(${JSON.stringify(GOLDEN_CHILD_READY_MARKER)});`,
                "console.log(JSON.stringify({ ok: true, result: { actor: { remaining: [] } } }));",
                "await new Promise((resolve) => setTimeout(resolve, 60_000));",
                "export const hangingScenario = {};",
                "",
            ].join("\n"),
        );
        await assertRejects(
            () =>
                runGoldenScenarioChildProcess({
                    scenarioModule: toFileUrl(scenarioPath).href,
                    exportName: "hangingScenario",
                    timeoutMs: 1000,
                }),
            Error,
            "Golden child failed (timeout)",
        );
    } finally {
        await fsRm(fixtureRoot, { recursive: true });
    }
});

test("expected-clean-exit scenarios reject a nonzero child exit after the pre-exit report", async () => {
    const fixtureRoot = await fsMkdtemp(join(tmpdir(), "golden-clean-exit-crash-"));
    const scenarioPath = join(fixtureRoot, "crashing-scenario.ts");
    try {
        await fsWriteFile(
            scenarioPath,
            [
                'import process from "node:process";',
                'if (process.env.WLD_GOLDEN_TUI_CHILD === "1") {',
                '    console.log(JSON.stringify({ ok: true, expectedCleanExit: true, result: { name: "crash", state: {}, events: [], actor: { remaining: [] } } }));',
                "    process.exit(7);",
                "}",
                'export const crashingScenario = { name: "crash", expectedCleanExit: true, assertions: [] };',
                "",
            ].join("\n"),
        );

        await assertRejects(
            () =>
                runGoldenScenarioChildProcess({
                    scenarioModule: toFileUrl(scenarioPath).href,
                    exportName: "crashingScenario",
                    timeoutMs: 10_000,
                }),
            Error,
            "Golden child failed",
        );
    } finally {
        await fsRm(fixtureRoot, { recursive: true });
    }
});

interface DiagnosticChildFailure extends Error {
    childPayload?: { artifactDir?: string };
}
interface NativeFailureDiagnostics {
    nativeFailureEvidence: {
        projectRoot: string;
        status: { code: number; stdout: string };
        planDiff: { code: number };
    };
}

test("composed Golden child failures retain read-only native evidence for their initialized project", async () => {
    const fixtureRoot = await fsMkdtemp(join(tmpdir(), "golden-native-evidence-"));
    const scenarioPath = join(fixtureRoot, "diagnostic-scenario.ts");
    try {
        await fsWriteFile(
            scenarioPath,
            `export const diagnosticScenario = {
            name: "native-evidence",
            composedTui: true,
            initialProjectFiles: [{ path: "diagnostic-dirty.txt", text: "retained evidence" }],
            actions: [],
            assertions: [() => { throw new Error("intentional native evidence failure"); }],
        };
`,
        );
        const error = (await assertRejects(
            () =>
                runGoldenScenarioChildProcess({
                    scenarioModule: toFileUrl(scenarioPath).href,
                    exportName: "diagnosticScenario",
                    timeoutMs: 30_000,
                }),
            Error,
            "intentional native evidence failure",
        )) as DiagnosticChildFailure;
        const artifact = error.childPayload?.artifactDir;
        assert(artifact, "Expected the composed child's retained diagnostic directory");
        const diagnostic: NativeFailureDiagnostics = JSON.parse(
            await fsReadFile(join(artifact, "diagnostics.json"), "utf8"),
        );
        assert(diagnostic.nativeFailureEvidence, "Child mode must capture its existing isolated environment");
        assertEquals(diagnostic.nativeFailureEvidence.status.code, 0);
        assertEquals(diagnostic.nativeFailureEvidence.planDiff.code, 0);
        assertStringIncludes(diagnostic.nativeFailureEvidence.status.stdout, "diagnostic-dirty.txt");
        assertStringIncludes(diagnostic.nativeFailureEvidence.projectRoot, "runwield-golden-tui-");
    } finally {
        await fsRm(fixtureRoot, { recursive: true });
    }
});
