import { test } from "node:test";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../../../testing/assertions.ts";

import { pathToFileURL as toFileUrl } from "node:url";
import { runGoldenScenarioChildProcess } from "./child-protocol.js";

const cases = [
    {
        action: "waitForPlanStatus",
        module: "../golden-scenarios/validation-workflow-tree-lifecycle.ts",
        exportName: "validationTreeAheadStatusScenario",
    },
    {
        action: "waitForWorktreeRegistryStatus",
        module: "../golden-scenarios/validation-workflow-tree-mechanical.ts",
        exportName: "validationTreeCiRetrySuccessScenario",
    },
];

for (const testCase of cases) {
    test(`Golden ${testCase.action} tolerates a forward wall-clock adjustment`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "golden-wait-clock-"));
        const path = join(root, "scenario.ts");
        try {
            await fsWriteFile(
                path,
                `import { ${testCase.exportName} as base } from ${JSON.stringify(
                    new URL(testCase.module, import.meta.url).href,
                )};
const now = Date.now;
export const scenario = {
    ...base,
    timeoutMs: 300000,
    actions: base.actions.map((action) => action.type !== ${JSON.stringify(testCase.action)} ? action : {
        ...action,
        get type() {
            setTimeout(() => { Date.now = () => now() + 100000; }, 50);
            return ${JSON.stringify(testCase.action)};
        },
    }),
};
`,
            );
            const result = await runGoldenScenarioChildProcess({
                scenarioModule: toFileUrl(path).href,
                exportName: "scenario",
                timeoutMs: 300000,
            });
            assertEquals(result.result.actor.remaining, []);
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}
