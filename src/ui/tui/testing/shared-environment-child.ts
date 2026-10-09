import process from "node:process";
/** Run one Golden TUI scenario in a fixture environment owned by the parent test. */

import { fileURLToPath as fromFileUrl, pathToFileURL as toFileUrl } from "node:url";
import { join } from "node:path";
import { _setTestStatePath } from "../../../cmd/init/init-state.ts";
import { GOLDEN_CHILD_READY_MARKER } from "./subprocess-runner.js";

interface SharedEnvironmentScenarioRequest {
    scenarioModule: string;
    exportName: string;
}

interface ScenarioModule {
    [exportName: string]: { name: string } | undefined;
}

const repoRoot = fromFileUrl(new URL("../../../..", import.meta.url));

async function main(): Promise<void> {
    const request = JSON.parse(process.argv.slice(2)[0] || "{}") as SharedEnvironmentScenarioRequest;
    process.env["WLD_GOLDEN_TUI_CHILD"] = "1";
    const runwieldDir = process.env["RUNWIELD_HOME"];
    if (!runwieldDir) throw new Error("Shared Golden child requires RUNWIELD_HOME.");
    _setTestStatePath(join(runwieldDir, "init-state.json"));

    const { runGoldenScenario } = await import("./scenario-runner.js");
    const moduleUrl = request.scenarioModule.startsWith("file:")
        ? request.scenarioModule
        : toFileUrl(join(repoRoot, request.scenarioModule)).href;
    const scenarioModule = await import(moduleUrl) as ScenarioModule;
    const scenario = scenarioModule[request.exportName];
    if (!scenario) throw new Error(`Missing scenario export: ${request.exportName}`);
    try {
        const result = await runGoldenScenario(scenario, {
            keepArtifacts: true,
            onReady: () => console.log(GOLDEN_CHILD_READY_MARKER),
        });
        console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
        console.log(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            artifactDir: error && typeof error === "object" && "artifactDir" in error
                ? String(error.artifactDir || "")
                : "",
        }));
        throw error;
    }
}

if (import.meta.main) {
    await main();
}
