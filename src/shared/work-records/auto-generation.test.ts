import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import { addEntry } from "../worktree-registry.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { listWorkRecords, writeWorkRecord } from "./store.js";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { autoGenerateWorkRecordForCompletedPlan } from "./auto-generation.ts";

async function saveStandalonePlan(projectRoot: string, supersedes: string[] = []): Promise<void> {
    await savePlan(projectRoot, "standalone", "# Standalone\n\n## Plan\n\nBuild the fixture feature.", {
        planId: "plan-standalone",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Built the standalone fixture feature.",
        affectedPaths: [],
        createdAt: "2026-07-14T00:00:00.000Z",
        status: "verified",
        ...(supersedes.length ? { supersedes } : {}),
    });
}

async function savePredecessor(projectRoot: string, recordId: string, title: string): Promise<void> {
    await writeWorkRecord(projectRoot, {
        kind: "work_record",
        recordId,
        status: "approved",
        scope: "planned_change",
        origin: "internal",
        completionMode: "verified",
        createdAt: "2026-07-13T00:00:00.000Z",
        provenance: { sourcePlans: [`plan-${recordId}`] },
    }, `# ${title}\n\n## Summary\n\nEarlier result.`);
}

async function saveEpicWithChild(projectRoot: string, terminal: boolean): Promise<void> {
    await savePlan(projectRoot, "epic", "# Epic\n\n## Plan\n\nCoordinate the fixture project.", {
        planId: "plan-epic",
        classification: "PROJECT",
        complexity: "MEDIUM",
        summary: terminal ? "Epic complete enough." : "Epic still active.",
        affectedPaths: [],
        createdAt: "2026-07-14T00:00:00.000Z",
        status: terminal ? "verified" : "ready_for_work",
        ...(terminal ? { epicCompletionMode: "done_enough" as const } : {}),
    });
    await savePlan(projectRoot, "epic/01-child", "# Child\n\n## Plan\n\nComplete one fixture slice.", {
        planId: "plan-child",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Child feature complete.",
        affectedPaths: [],
        createdAt: "2026-07-14T00:00:00.000Z",
        status: "verified",
        parentPlan: "epic",
        order: 1,
    });
}

Deno.test("automatic Work Record generation writes a canonical record and Plan backlink", async () => {
    await withRuntimeCommandFixture("work-record-auto-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        await saveStandalonePlan(projectRoot);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Standalone Outcome",
            summary: "Completed through the real automatic generation path.",
            futurePlanningNotes: "Reuse this fixture-backed flow.",
        }))]);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "generated");
        const records = await listWorkRecords(projectRoot);
        assertEquals(records.length, 1);
        assertEquals(records[0].attrs.provenance?.sourcePlans, ["plan-standalone"]);
        assertStringIncludes(records[0].summary, "real automatic generation path");
        assertEquals(
            (await loadPlan(projectRoot, "standalone"))?.attrs.workRecord?.recordId,
            records[0].attrs.recordId,
        );
    });
});

Deno.test("automatic Work Record generation reads acceptance from the registered worktree", async () => {
    await withRuntimeCommandFixture("work-record-accepted-worktree-", async ({ projectRoot, setModelMessages }) => {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await savePlan(projectRoot, "accepted", "# Accepted\n\nDelivered through the release PR.", {
            planId: "accepted-plan",
            classification: "PLANNED_CHANGE",
            status: "in_progress",
        });
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "Plan"]);
        const path = `${projectRoot}-execution`;
        await git(projectRoot, ["worktree", "add", "-b", "worktree/accepted", path]);
        try {
            await addEntry(projectRoot, {
                id: "accepted-attempt",
                planId: "accepted-plan",
                planName: "accepted",
                path,
                branch: "worktree/accepted",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
                status: "active",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            const plan = await loadPlan(path, "accepted");
            if (!plan) throw new Error("Missing fixture Plan");
            await updatePlanFrontMatter(
                path,
                "accepted",
                {
                    status: "user_verified",
                    userVerificationNote: "Shipped through the release PR.",
                    userVerifiedAt: new Date().toISOString(),
                },
                {},
                { expectedRevision: plan.revision },
            );
            setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
                title: "Accepted release",
                summary: "The user confirmed the release shipped.",
            }))]);
            const result = await autoGenerateWorkRecordForCompletedPlan({
                cwd: projectRoot,
                planName: "accepted",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            });
            assertEquals(result.status, "generated", result.message);
            const records = await listWorkRecords(path);
            assertEquals(records.length, 1);
            assertEquals(records[0].attrs.completionMode, "user_verified");
            assertStringIncludes(records[0].summary, "Shipped through the release PR.");
            assertEquals((await loadPlan(path, "accepted"))?.attrs.workRecord?.recordId, records[0].attrs.recordId);
            assertEquals((await loadPlan(projectRoot, "accepted"))?.attrs.status, "in_progress");
            assertEquals((await loadPlan(projectRoot, "accepted"))?.attrs.workRecord, undefined);
        } finally {
            await git(projectRoot, ["worktree", "remove", "--force", path]);
        }
    });
});

Deno.test("automatic child completion generates only the terminal parent Epic record", async () => {
    await withRuntimeCommandFixture("work-record-auto-epic-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        await saveEpicWithChild(projectRoot, true);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Epic Outcome",
            summary: "Completed the parent Epic with its fixture child.",
        }))]);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "epic/01-child",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "generated");
        assertEquals(result.targetPlanName, "epic");
        const records = await listWorkRecords(projectRoot);
        assertEquals(records.length, 1);
        assertEquals(records[0].attrs.provenance?.sourcePlans, ["plan-epic"]);
        assertEquals((await loadPlan(projectRoot, "epic/01-child"))?.attrs.workRecord, undefined);
        assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.workRecord?.recordId, records[0].attrs.recordId);
    });
});

Deno.test("automatic child completion waits for its real parent Epic to become terminal", async () => {
    await withRuntimeCommandFixture("work-record-auto-wait-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await saveEpicWithChild(projectRoot, false);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "epic/01-child",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "skipped");
        assertEquals(result.reason, "parent_not_terminal");
        assertEquals(await listWorkRecords(projectRoot, { createDir: false }), []);
        assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.workRecord, undefined);
    });
});

Deno.test("automatic generation honors the project Work Record setting", async () => {
    await withRuntimeCommandFixture("work-record-auto-disabled-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await saveStandalonePlan(projectRoot);
        await setCustomSetting("workRecords", { autoGenerateOnPlanCompletion: false }, "project");

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "disabled");
        assertEquals(await listWorkRecords(projectRoot, { createDir: false }), []);
        assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.workRecord, undefined);
    });
});

Deno.test("automatic generation persists normalized pending supersession proposals", async () => {
    await withRuntimeCommandFixture("work-record-auto-proposal-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        const predecessorId = "11111111-1111-4111-8111-111111111111";
        await savePredecessor(projectRoot, predecessorId, "Earlier Outcome");
        await saveStandalonePlan(projectRoot);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Standalone Outcome",
            summary: "Completed with a possible replacement.",
            supersessionProposals: [
                { recordId: ` ${predecessorId} `, reason: " More complete evidence. " },
                { recordId: predecessorId, reason: "Duplicate must be removed." },
            ],
        }))]);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "generated");
        assertEquals(result.supersessionProposals, [{ recordId: predecessorId, reason: "More complete evidence." }]);
        assertStringIncludes(result.message, `${predecessorId} (More complete evidence.)`);
        assertStringIncludes(result.message, `Run wld wr supersede ${result.recordId}.`);
        const successor = (await listWorkRecords(projectRoot)).find((record) =>
            record.attrs.recordId === result.recordId
        );
        assertEquals(successor?.attrs.supersessionProposal?.candidates, result.supersessionProposals);
        assertEquals(
            (await listWorkRecords(projectRoot)).find((record) => record.attrs.recordId === predecessorId)?.attrs
                .status,
            "approved",
        );
    });
});

Deno.test("automatic generation settles Plan declarations and keeps only undeclared proposals pending", async () => {
    await withRuntimeCommandFixture("work-record-auto-declared-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        const declaredId = "22222222-2222-4222-8222-222222222222";
        const proposedId = "33333333-3333-4333-8333-333333333333";
        await savePredecessor(projectRoot, declaredId, "Declared Earlier Outcome");
        await savePredecessor(projectRoot, proposedId, "Possible Earlier Outcome");
        await saveStandalonePlan(projectRoot, [declaredId]);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Settled Outcome",
            summary: "Completed and reconciled.",
            supersessionProposals: [
                { recordId: declaredId, reason: "The Plan already settled this relation." },
                { recordId: proposedId, reason: "A separate possible replacement." },
            ],
        }))]);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        const records = await listWorkRecords(projectRoot);
        const successor = records.find((record) => record.attrs.recordId === result.recordId);

        assertEquals(result.status, "generated");
        assertEquals(successor?.attrs.supersedes, [declaredId]);
        assertEquals(
            records.find((record) => record.attrs.recordId === declaredId)?.attrs.supersededBy,
            result.recordId,
        );
        assertEquals(successor?.attrs.supersessionProposal?.candidates, [{
            recordId: proposedId,
            reason: "A separate possible replacement.",
        }]);
        assertEquals(result.supersessionProposals, successor?.attrs.supersessionProposal?.candidates);
    });
});

Deno.test("automatic generation preserves terminal Plan state when Recorder fails", async () => {
    await withRuntimeCommandFixture("work-record-auto-failure-", async ({ projectRoot, setModelResponseFactories }) => {
        Deno.chdir(projectRoot);
        await saveStandalonePlan(projectRoot);
        let calls = 0;
        const respond = () => {
            calls++;
            return fauxAssistantMessage(fauxText("Recorder returned private fixture output."));
        };
        setModelResponseFactories([respond, respond]);

        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.status, "failed");
        assertStringIncludes(result.message, "wld wr retry");
        assertStringIncludes(result.message, "wld wr backfill command regenerates");
        assertEquals(await listWorkRecords(projectRoot), []);
        const plan = await loadPlan(projectRoot, "standalone");
        assertEquals(plan?.attrs.status, "verified");
        assertEquals(plan?.attrs.workRecord?.status, "failed");
        assertEquals(calls, 2);
        assertStringIncludes(plan?.attrs.workRecord?.error || "", "after 2 attempt(s)");
        assertStringIncludes(plan?.attrs.workRecord?.error || "", "without an accepted work_record_completed call");
        assertEquals(plan?.attrs.workRecord?.error?.includes("private fixture output"), false);
    });
});

Deno.test("Recorder corrects a text-only response once using the original source context", async () => {
    await withRuntimeCommandFixture("work-record-retry-", async ({ projectRoot, setModelResponseFactories }) => {
        Deno.chdir(projectRoot);
        await saveStandalonePlan(projectRoot);
        let calls = 0;
        setModelResponseFactories([
            () => {
                calls++;
                return fauxAssistantMessage(fauxText('{"title":"Outcome","summary":"Text is not acceptance."}'));
            },
            (context) => {
                calls++;
                assertStringIncludes(JSON.stringify(context), "Build the fixture feature.");
                assertStringIncludes(JSON.stringify(context), "No work_record_completed submission was accepted");
                return fauxAssistantMessage(fauxToolCall("work_record_completed", {
                    title: "Recovered Outcome",
                    summary: "Recorded after the corrective turn.",
                }));
            },
        ]);
        const result = await autoGenerateWorkRecordForCompletedPlan({
            cwd: projectRoot,
            planName: "standalone",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        assertEquals(result.status, "generated");
        assertEquals(calls, 2);
        assertEquals((await listWorkRecords(projectRoot)).length, 1);
        assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.workRecord?.status, "generated");
    });
});

for (const stopReason of ["error", "aborted"] as const) {
    Deno.test(`Recorder does not retry a ${stopReason} turn as a missing-tool correction`, async () => {
        await withRuntimeCommandFixture("work-record-stop-", async ({ projectRoot, setModelResponseFactories }) => {
            Deno.chdir(projectRoot);
            await saveStandalonePlan(projectRoot);
            let calls = 0;
            const respond = () => {
                calls++;
                return { ...fauxAssistantMessage(fauxText("")), stopReason, errorMessage: "Fixture provider stopped." };
            };
            setModelResponseFactories([respond, respond]);
            const result = await autoGenerateWorkRecordForCompletedPlan({
                cwd: projectRoot,
                planName: "standalone",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            });
            assertEquals(result.status, "failed");
            assertEquals(calls, 1);
            assertEquals(await listWorkRecords(projectRoot), []);
            assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.status, "verified");
        });
    });
}
