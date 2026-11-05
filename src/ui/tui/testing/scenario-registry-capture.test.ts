import { test } from "node:test";
import { deepEqual, equal, rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runGoldenScenarioChildProcess } from "./child-protocol.js";

const cases = [
    { mode: "removed", name: "waits for fresh authority when publication removes a checkout", error: null },
    {
        mode: "pending",
        name: "does not capture an empty registry while admission remains pending",
        error: /workflow authority is still pending/,
    },
    {
        mode: "blocked",
        name: "preserves malformed-authority errors during cleanup",
        error: /Home runtime marker is unreadable/,
    },
];

for (const scenarioCase of cases)
    test(`Golden project capture ${scenarioCase.name}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "golden-registry-capture-"));
        const scenarioPath = join(directory, "scenario.ts");
        try {
            await writeFile(
                scenarioPath,
                `
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getCwd } from ${JSON.stringify(new URL("../../../constants.js", import.meta.url).href)};
import { git } from ${JSON.stringify(new URL("../../../shared/git-test-fixture.ts", import.meta.url).href)};
import { enterProjectRuntime } from ${JSON.stringify(new URL("../../../shared/project-runtime-layout.ts", import.meta.url).href)};
const root = await fs.realpath(getCwd());
const linked = root + "-linked";
const mode = ${JSON.stringify(scenarioCase.mode)};
const layout = await enterProjectRuntime(root);
if (mode !== "pending") {
    await git(root, ["worktree", "add", "-b", "capture-cleanup", linked]);
    await enterProjectRuntime(linked);
}
const lstat = fs.lstat;
let removed = false;
let armed = false;
Object.defineProperty(fs, "lstat", { value: async (...args: Parameters<typeof fs.lstat>) => {
    const result = await lstat(...args);
    if (armed && !removed && String(args[0]) === join(linked, ".git")) {
        removed = true;
        if (mode === "removed") await git(root, ["worktree", "remove", "--force", linked]);
        if (mode === "blocked") await fs.writeFile(layout.primary.layoutMarkerPath, "invalid marker\\n");
    }
    return result;
}});
export const scenario = {
    name: "capture-during-publication-cleanup",
    composedTui: true,
    actions: [{ get type() {
        if (!armed && mode === "pending") {
            const result = spawnSync("git", ["worktree", "add", "-b", "capture-cleanup", linked], { cwd: root });
            if (result.status !== 0) throw new Error(String(result.stderr));
        }
        armed = true;
        return "captureProjectState";
    }, planNames: [], timeoutMs: mode === "pending" ? 100 : 10000 }],
    assertions: [() => { if (!removed) throw new Error("Cleanup race was not exercised"); }],
};
`,
            );
            const run = () =>
                runGoldenScenarioChildProcess({
                    scenarioModule: pathToFileURL(scenarioPath).href,
                    exportName: "scenario",
                    timeoutMs: 30000,
                });
            if (scenarioCase.error) await rejects(run, scenarioCase.error);
            else {
                const result = await run();
                equal(result.result.actor.remaining.length, 0);
                deepEqual(result.result.state.projectState.registryEntries, []);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
