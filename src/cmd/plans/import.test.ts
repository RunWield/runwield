import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { withPlanCommandFixture } from "./plans-command-test-fixture.ts";
import { runPlansCommand } from "./index.ts";
import { listPlans } from "../../plan-store.js";
import { getDeliveryCopyPolicy, getExactProjectCustomSetting } from "../../shared/settings.js";

test("public Plan import preserves sources and retries without duplicate packages or implicit copy consent", async () => {
    await withPlanCommandFixture("public-plan-import-", async ({ projectRoot }) => {
        const folder = join(projectRoot, "docs/plans");
        const source = join(folder, "proposal.md");
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(source, "# Proposal\n");
        deepEqual(await listPlans(projectRoot), []);
        await runPlansCommand(["import", source]);
        const first = await listPlans(projectRoot);
        equal(first.length, 1);
        await runPlansCommand(["import", folder]);
        const second = await listPlans(projectRoot);
        equal(second.length, 1);
        equal(second[0].attrs.planId, first[0].attrs.planId);
        equal(await fs.readFile(source, "utf8"), "# Proposal\n");
        deepEqual(getDeliveryCopyPolicy(projectRoot), { plans: false, workRecords: true });
        equal(getExactProjectCustomSetting("plans", projectRoot), undefined);
    });
});

for (const answer of ["", "yes", "no", null] as const) {
    test(`folder import records only an actual delivery-copy answer ${JSON.stringify(answer)}`, async () => {
        await withPlanCommandFixture("plan-import-consent-", async ({ projectRoot }) => {
            const { setExactProjectCustomSetting } = await import("../../shared/settings.js");
            const process = (await import("node:process")).default;
            const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
            const originalPrompt = globalThis.prompt;
            let prompts = 0;
            Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            globalThis.prompt = () => {
                prompts++;
                return answer;
            };
            try {
                setExactProjectCustomSetting("plans", { anotherPreference: "preserved" }, projectRoot);
                setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, projectRoot);
                const folder = join(projectRoot, "docs/plans");
                await fs.mkdir(folder, { recursive: true });
                await fs.writeFile(join(folder, "choice.md"), "# Choice\n");
                await runPlansCommand(["import", folder]);
                equal(prompts, 1);
                const expected = answer === null ? undefined : answer !== "no";
                const saved = getExactProjectCustomSetting("plans", projectRoot);
                deepEqual(
                    saved,
                    expected === undefined
                        ? { anotherPreference: "preserved" }
                        : {
                              anotherPreference: "preserved",
                              deliveryCopies: expected,
                              importDeliveryCopiesAnswer: expected,
                          },
                );
                deepEqual(getDeliveryCopyPolicy(projectRoot), { plans: expected ?? false, workRecords: false });
                await runPlansCommand(["import", folder]);
                equal(prompts, answer === null ? 2 : 1);
                equal((await listPlans(projectRoot)).length, 1);
            } finally {
                globalThis.prompt = originalPrompt;
                if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
                else Reflect.deleteProperty(process.stdin, "isTTY");
            }
        });
    });
}

test("explicit import assigns an idless legacy draft without changing its source", async () => {
    await withPlanCommandFixture("idless-legacy-plan-import-", async ({ projectRoot }) => {
        const folder = join(projectRoot, "docs/plans");
        const source = join(folder, "idless.md");
        const markdown = "---\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Idless draft\n";
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(source, markdown);
        await runPlansCommand(["import", source]);
        const plans = await listPlans(projectRoot);
        equal(plans.length, 1);
        equal(plans[0].name, "idless");
        equal(typeof plans[0].attrs.planId, "string");
        equal(await fs.readFile(source, "utf8"), markdown);
        await runPlansCommand(["import", source]);
        equal((await listPlans(projectRoot))[0].attrs.planId, plans[0].attrs.planId);
    });
});
