import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../shared/session/hosted-session.js";
import { createPlanWrittenTool } from "./plan-written.ts";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../plan-store.js";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../shared/project-runtime-layout.ts";

const EXTENSION_CONTEXT = {} as ExtensionToolContext;

Deno.test("plan_written recovers old controller files and opens review after migration", async () => {
    await withRuntimeCommandFixture("plan-written-old-runtime-", async ({ projectRoot }) => {
        const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        Deno.env.delete("WLD_TEST_SANDBOX_HOME");
        const hostedSession = new HostedSession({ id: "plan-written-recovery", cwd: projectRoot });
        try {
            await savePlan(projectRoot, "demo", "# Demo\n\nKeep the implementation.", {
                planId: "demo",
                classification: "PLANNED_CHANGE",
                status: "approved",
            });
            await enterProjectRuntime(projectRoot);
            const layout = resolveProjectRuntimeLayout(projectRoot);
            const current = await Deno.readTextFile(join(layout.primary.controllerPlansDir, "demo.json"));
            const legacyDirectory = join(projectRoot, ".wld", "controller", "plans");
            await Deno.mkdir(legacyDirectory, { recursive: true });
            await Deno.writeTextFile(join(legacyDirectory, "demo.json"), current);
            await Deno.writeTextFile(join(projectRoot, ".wld", "worktrees.json"), '{"version":2,"entries":[]}');
            await Deno.mkdir(join(projectRoot, ".wld", "plan-locks"), { recursive: true });
            let reviews = 0;
            hostedSession.setInteractionAdapter({
                requestInteraction: async (request) => {
                    assertEquals(request.type, "plan_review");
                    reviews++;
                    const plan = await loadPlan(projectRoot, "demo");
                    return {
                        outcome: "accepted",
                        _meta: { approved: true, approvalAction: "later", revision: plan?.revision },
                    };
                },
            });
            const result = await createPlanWrittenTool({ hostedSession }).execute(
                "review-after-migration",
                { planName: "demo" },
                undefined,
                undefined,
                EXTENSION_CONTEXT,
            );
            assertEquals(reviews, 1, resultText(result));
            assertEquals((await loadPlan(projectRoot, "demo"))?.attrs.status, "ready_for_work", resultText(result));
            assertEquals((result.details as { outcome: string }).outcome, "saved");
        } finally {
            hostedSession.dispose();
            if (sandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", sandboxHome);
        }
    });
});

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    const item = result.content[0];
    return item?.type === "text" ? item.text || "" : "";
}

Deno.test("plan_written rejects the reserved Epic Artifact name before review", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "plan-written-artifact-" });
    try {
        const hostedSession = new HostedSession({ id: "plan-written-artifact", cwd });
        const tool = createPlanWrittenTool({ hostedSession });

        const result = await tool.execute(
            "call",
            {
                planName: "epic/manual-qa",
            },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );

        const details = result.details as { outcome?: string; reason?: string } | null;
        assertEquals(details?.outcome, "repair_required");
        assertEquals(details?.reason, "reserved_epic_artifact");
        assertStringIncludes(resultText(result), "reserved for an Epic Artifact");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("direct Plan retains explicit verification through skipped Init, reload, and deliberate changes", async () => {
    await withRuntimeCommandFixture("plan-command-", async ({ projectRoot }) => {
        const { getExactProjectCustomSetting, setExactProjectCustomSetting } = await import("../shared/settings.js");
        const { runLocalCI } = await import("../shared/workflow/validation-local-ci.ts");
        const session = new HostedSession({ id: "plan-command", cwd: projectRoot });
        try {
            await savePlan(projectRoot, "demo", "# Demo", { classification: "PLANNED_CHANGE", status: "draft" });
            session.setInteractionAdapter({
                requestInteraction: (request) => {
                    assertEquals(request.type, "plan_review");
                    return Promise.resolve({ outcome: "canceled" });
                },
            });
            const tool = createPlanWrittenTool({ hostedSession: session });
            const submit = (command: string, intent: "discovered" | "user_selected") =>
                tool.execute(
                    crypto.randomUUID(),
                    {
                        planName: "demo",
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        verificationCommand: { command, intent },
                    },
                    undefined,
                    undefined,
                    EXTENSION_CONTEXT,
                );
            const command = `  CHECK='whole suite' sh -c 'printf "%s" "$CHECK"' && printf '%s' '-ok'  `;
            await submit(command, "user_selected");
            assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), command);
            const reloaded = new HostedSession({ id: "command-reloaded", cwd: projectRoot });
            reloaded.setInteractionAdapter({
                requestInteraction: () => Promise.reject(new Error("must not ask again")),
            });
            try {
                const result = await runLocalCI({
                    hostedSession: reloaded,
                    cwd: projectRoot,
                    settingsPolicy: "exact-project",
                });
                assertEquals(result.kind, "completed");
                if (result.kind === "completed") {
                    assertEquals(result.exitCode, 0);
                    assertStringIncludes(result.output, "whole suite-ok");
                }
                const escapedSpace = "printf '%s' verify\\ ";
                await submit(escapedSpace, "user_selected");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), escapedSpace);
                const escapedResult = await runLocalCI({
                    hostedSession: reloaded,
                    cwd: projectRoot,
                    settingsPolicy: "exact-project",
                });
                if (escapedResult.kind !== "completed") throw new Error("Expected command to run");
                assertStringIncludes(escapedResult.output, "verify ");
                setExactProjectCustomSetting("verification_command", "printf repaired", projectRoot);
                await submit("printf discovered", "discovered");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), "printf repaired");
                await submit("printf replacement", "user_selected");
                assertEquals(getExactProjectCustomSetting("verification_command", projectRoot), "printf replacement");
            } finally {
                reloaded.dispose();
            }
        } finally {
            session.dispose();
        }
    });
});
