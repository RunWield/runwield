import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { findPlansByParent, loadPlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { prepareSessionPlanningWorktree } from "./session-planning-worktree.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { readEpicDeliveryState, reconcileEpicDelivery, runEpicIntegrationGate } from "./epic-integration.ts";
import {
    writePlan,
    childAttrs,
    epicWithPendingSecondChild,
    deliverSecondChild,
    scriptedReviewer,
    scriptedChecks,
    PASSING_CHECKS,
    gateSession,
} from "./epic-integration-test-fixture.ts";

async function epicWithOpenRepairDraft() {
    const { repo } = await epicWithPendingSecondChild();
    await deliverSecondChild(repo);
    await reconcileEpicDelivery(repo, "epic");
    const repairName = "epic/03-repair-integration-findings";
    await writePlan(
        repo,
        repairName,
        childAttrs(3, { status: "draft" }),
        [
            "# Repair integration findings",
            "",
            "## Context",
            "",
            "The integration gate checked the Epic branch `epic/epic` at `old-commit` and found the problems below. Keep my inline note.",
            "Keep this context note.",
            "",
            "## Objective",
            "",
            "Keep my objective.",
            "",
            "## Findings",
            "",
            "Old findings.",
            "",
            "## Verification Plan",
            "",
            "Keep my checks.",
            "",
        ].join("\n"),
    );
    await setCustomSetting("codereview", "none", "project", repo);
    return { repo, repairName };
}

test("an implemented Epic can retry with a primary-only repair draft, but the automatic gate still waits", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const state = await readEpicDeliveryState(repo, "epic");
    assertEquals(state?.allSettled, false);
    assertEquals(state?.children.find((child) => child.name === repairName)?.openRepairDraft, true);
    const reconciled = await reconcileEpicDelivery(repo, "epic");
    assertEquals(reconciled.gateReady, false);
    assertEquals(reconciled.gateRetryReady, true);
});

for (const status of ["approved", "in_progress"]) {
    test(`a ${status} repair child blocks an Epic retry`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        await writePlan(repo, repairName, childAttrs(3, { status }), "# Started repair");
        const reconciled = await reconcileEpicDelivery(repo, "epic");
        assertEquals(reconciled.gateRetryReady, false);
        const result = await runEpicIntegrationGate({
            hostedSession: gateSession().hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({ approved: true }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
        });
        assertEquals(result.kind, "not_ready");
    });
}

test("an undelivered ordinary child blocks retry even with an open repair draft", async () => {
    const { repo } = await epicWithOpenRepairDraft();
    await writePlan(repo, "epic/04-extra-scope", childAttrs(4, { status: "draft" }), "# Extra scope");
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateRetryReady, false);
});

test("a passing retry closes all open repair drafts without changing their bodies or identities", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const older = await loadPlan(repo, repairName);
    const secondName = "epic/04-repair-integration-findings-2";
    await writePlan(repo, secondName, childAttrs(4, { status: "draft" }), "# Another repair\n");
    const second = await loadPlan(repo, secondName);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result, { kind: "passed", commit: head });
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "reviewed");
    for (const [name, before] of [
        [repairName, older],
        [secondName, second],
    ] as const) {
        const after = await loadPlan(repo, name);
        assertEquals(after?.attrs.status, "closed_without_verification");
        assertEquals(after?.attrs.planId, before?.attrs.planId);
        assertEquals(after?.attrs.order, before?.attrs.order);
        assertEquals(after?.body, before?.body);
        assertStringIncludes(after?.attrs.closedWithoutVerificationReason || "", head);
        assertStringIncludes(after?.attrs.closedWithoutVerificationReason || "", "epic/epic");
    }
});

for (const oldFindings of [
    "Old findings.",
    "### Failed checks\n\n```text\nOld output.\n## Summary\nOld summary.\n```\n\n### Old review finding\n\nOld findings.",
    "### Failed checks\n\n~~~~text\nOld output.\n~~~\n## Summary\nOld summary.\n~~~~\n\nOld findings.",
]) {
    test(`a findings retry replaces ${oldFindings.includes("## Summary") ? (oldFindings.includes("~~~~") ? "tilde-fenced" : "backtick-fenced") : "plain"} findings and preserves other sections`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        await writePlan(
            repo,
            "epic/04-repair-integration-findings-2",
            childAttrs(4, { status: "draft" }),
            (await loadPlan(repo, repairName))!.body.replace("Old findings.", oldFindings),
        );
        const newestName = "epic/04-repair-integration-findings-2";
        const before = await loadPlan(repo, newestName);
        const older = await loadPlan(repo, repairName);
        const head = await git(repo, ["rev-parse", "epic/epic"]);
        const { hostedSession } = gateSession();
        hostedSession.setInteractionAdapter({
            requestInteraction: async (request) => {
                assertEquals(request.type, "select");
                assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
                return { outcome: "selected", value: "repair" };
            },
        });
        const result = await runEpicIntegrationGate({
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({ approved: true }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "New check failure $& $` $'" }),
        });
        assertEquals(result.kind, "findings");
        if (result.kind !== "findings") throw new Error("Expected retry findings");
        assertEquals(result.repairChild.childPlanName, newestName);
        const location = await resolveWorkflowPlanLocation(repo, newestName, { readOnly: true });
        const after = location.plan;
        assertEquals(after?.markdown.split("---")[1], before?.markdown.split("---")[1]);
        assertStringIncludes(after?.body || "", head);
        assertStringIncludes(after?.body || "", "New check failure $& $` $'");
        for (const note of [
            "Keep this context note.",
            "Keep my objective.",
            "Keep my checks.",
            "Keep my inline note.",
        ]) {
            assertStringIncludes(after?.body || "", note);
        }
        for (const stale of ["Old findings.", "Old output.", "Old summary.", "### Old review finding"]) {
            assertEquals(after!.body.includes(stale), false);
        }
        const expectedBody = before!.body.replace("old-commit", head).replace(`## Findings\n\n${oldFindings}\n\n`, "");
        assertEquals(after!.body.replace(/## Findings\n[\s\S]*?(?=## Verification Plan)/, ""), expectedBody);
        assertEquals((await loadPlan(repo, repairName))?.markdown, older?.markdown);
        assertEquals((await findPlansByParent(repo, "epic")).length, 4);
    });
}

test("a passing retry can close a repair draft already published on the Epic branch", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const original = await loadPlan(repo, repairName);
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["add", `docs/plans/${repairName}.md`]);
    await git(repo, ["commit", "-m", "Publish repair draft"]);
    await git(repo, ["switch", "main"]);
    await writePlan(repo, repairName, childAttrs(3, { status: "draft" }), `${original?.body}\nKeep my local note.\n`);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks(PASSING_CHECKS),
    });
    assertEquals(result.kind, "passed");
    const closed = (await resolveWorkflowPlanLocation(repo, repairName, { readOnly: true })).plan;
    assertEquals(closed?.attrs.status, "closed_without_verification");
    assertEquals(closed?.body, `${original?.body}\nKeep my local note.\n`);
    assertEquals((await reconcileEpicDelivery(repo, "epic")).state?.allSettled, true);
});

test("a started repair in its registered document blocks retry despite a draft on the branch", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    await git(repo, ["switch", "epic/epic"]);
    await git(repo, ["add", `docs/plans/${repairName}.md`]);
    await git(repo, ["commit", "-m", "Repair draft"]);
    await git(repo, ["switch", "main"]);
    await prepareSessionPlanningWorktree(repo, repairName);
    await recordPlanEvent({ cwd: repo, planName: repairName, event: "review_approved", currentStatus: "draft" });
    assertEquals((await reconcileEpicDelivery(repo, "epic")).gateRetryReady, false);
});

for (const branchStatus of ["approved", "verified"]) {
    test(`a stale primary draft does not hide a ${branchStatus} repair on the Epic branch`, async () => {
        const { repo, repairName } = await epicWithOpenRepairDraft();
        const primaryDraft = (await loadPlan(repo, repairName))!.markdown;
        await git(repo, ["switch", "epic/epic"]);
        await writePlan(repo, repairName, childAttrs(3, { status: branchStatus }), "# Branch repair");
        await git(repo, ["add", `docs/plans/${repairName}.md`]);
        await git(repo, ["commit", "-m", "Advance repair on branch"]);
        await git(repo, ["switch", "main"]);
        await fsWriteFile(join(repo, `docs/plans/${repairName}.md`), primaryDraft);
        const reconciled = await reconcileEpicDelivery(repo, "epic");
        assertEquals(reconciled.state?.children.find((child) => child.name === repairName)?.status, branchStatus);
        assertEquals(reconciled.gateRetryReady, false);
        assertEquals(reconciled.gateReady, branchStatus === "verified");
    });
}

test("a paused retry leaves the Epic and its repair draft unchanged", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const before = await loadPlan(repo, repairName);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: scriptedChecks({ kind: "canceled", output: "Canceled" }),
    });
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "implemented");
    assertEquals((await loadPlan(repo, repairName))?.markdown, before?.markdown);
});

test("a branch move during retry leaves the repair draft unchanged", async () => {
    const { repo, repairName } = await epicWithOpenRepairDraft();
    const before = await loadPlan(repo, repairName);
    const head = await git(repo, ["rev-parse", "epic/epic"]);
    const result = await runEpicIntegrationGate({
        hostedSession: gateSession().hostedSession,
        projectRoot: repo,
        epicPlanName: "epic",
        semanticReviewPort: scriptedReviewer({ approved: true }),
        workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
        localCIPort: {
            run: async () => {
                const moved = await git(repo, ["commit-tree", `${head}^{tree}`, "-p", head, "-m", "Branch moved"]);
                await git(repo, ["update-ref", "refs/heads/epic/epic", moved, head]);
                return PASSING_CHECKS;
            },
        },
    });
    assertEquals(result.kind, "not_ready");
    assertEquals((await loadPlan(repo, "epic"))?.attrs.status, "implemented");
    assertEquals((await loadPlan(repo, repairName))?.markdown, before?.markdown);
});
