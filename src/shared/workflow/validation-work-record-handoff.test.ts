import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type RuntimeCommandFixture, withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { getRunWieldSessionDir } from "../session/root-session.js";
import { listWorkRecords, writeWorkRecord } from "../work-records/store.js";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { attachRecorder, makeUi } from "./validation-test-helpers.js";
import { runFeaturePostVerificationHandoffs } from "./validation-helpers.ts";

const PREDECESSOR_RECORD_ID = "33333333-3333-4333-8333-333333333333";
type SupersessionInteractionDecision = "confirm" | "reject" | "later" | null;

async function runWorkRecordHandoff(
    fixture: RuntimeCommandFixture,
    decision: SupersessionInteractionDecision = "later",
) {
    const { projectRoot, setModelResponseFactories } = fixture;
    await writeWorkRecord(
        projectRoot,
        {
            kind: "work_record",
            recordId: PREDECESSOR_RECORD_ID,
            status: "approved",
            scope: "planned_change",
            origin: "internal",
            completionMode: "verified",
            createdAt: "2026-08-02T00:00:00.000Z",
            provenance: { sourcePlans: ["older-feature-id"] },
        },
        "# Older Feature Outcome\n\n## Summary\n\nThe older implementation.",
    );
    await savePlan(projectRoot, "verified-feature", "# Verified Feature\n\n## Plan\n\nShip it.", {
        planId: "verified-feature-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Verified fixture feature.",
        affectedPaths: [],
        createdAt: "2026-08-03T00:00:00.000Z",
        status: "verified",
    });
    const respondToHandoff: FauxResponseFactory = (context) =>
        JSON.stringify(context).includes("post-verification checklist")
            ? fauxAssistantMessage(
                fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps\n- [ ] Exercise the verified feature.",
                }),
            )
            : fauxAssistantMessage(fauxToolCall("work_record_completed", {
                title: "Verified Feature Outcome",
                summary: "Generated through the real post-verification handoff.",
                supersessionProposals: [{
                    recordId: PREDECESSOR_RECORD_ID,
                    reason: "The verified implementation replaces the older implementation.",
                }],
            }));
    setModelResponseFactories([respondToHandoff, respondToHandoff]);
    const mnemotecaPort = createWorkRecordMnemotecaFixture();
    const ui = makeUi();
    ui.promptSelect = () => {
        ui.promptSelections.push(decision === null ? "canceled" : decision);
        return Promise.resolve(decision);
    };
    const sessionManager = SessionManager.create(projectRoot, getRunWieldSessionDir(projectRoot));
    const sessionManagerPort = {
        getSessionId: () => sessionManager.getSessionId(),
        getCwd: () => sessionManager.getCwd(),
        appendCustomEntry: <T>(customType: string, data: T) => sessionManager.appendCustomEntry(customType, data),
    };
    const hostedSession = attachRecorder(
        new HostedSession({
            id: "validation-work-record-handoff",
            cwd: projectRoot,
            sessionManager: sessionManagerPort,
        }),
        ui,
    );

    try {
        await runFeaturePostVerificationHandoffs({
            hostedSession,
            planName: "verified-feature",
            planContent: "# Verified Feature",
            projectRoot,
            mnemotecaPort,
        });
        return {
            records: await listWorkRecords(projectRoot),
            indexCount: mnemotecaPort.snapshot().length,
            sessionManager,
            ui,
        };
    } finally {
        hostedSession.dispose();
    }
}

test("post-verification handoffs run real Work Record machinery through the Mnemoteca port", async () => {
    await withRuntimeCommandFixture("validation-work-record-", async (fixture) => {
        const { records, indexCount, sessionManager, ui } = await runWorkRecordHandoff(fixture);
        const generated = records.find((record) =>
            record.attrs.provenance?.sourcePlans?.includes("verified-feature-id")
        );

        assertEquals(records.length, 2);
        assertEquals(generated?.attrs.provenance?.sourcePlans, ["verified-feature-id"]);
        assertStringIncludes(generated?.summary || "", "real post-verification handoff");
        assertEquals(generated?.attrs.supersessionProposal?.candidates[0].recordId, PREDECESSOR_RECORD_ID);
        assertEquals(indexCount, 1);
        const checklist = sessionManager.getEntries().find((entry) =>
            entry.type === "custom" && entry.customType === "runwield.manual_qa_checklist"
        );
        assertEquals(checklist?.type, "custom");
        if (checklist?.type === "custom") {
            assertStringIncludes(JSON.stringify(checklist.data), "Exercise the verified feature");
        }
        const qaStartIndex = ui.messages.findIndex((message: string) =>
            message === "Generating the manual QA test list..."
        );
        const creationStartIndex = ui.messages.findIndex((message: string) =>
            message === "Generating the Work Record for the current plan..."
        );
        const creationDoneIndex = ui.messages.findIndex((message: string) => message === "The Work Record is ready.");
        assertEquals(qaStartIndex >= 0, true);
        assertEquals(creationStartIndex >= 0, true);
        assertEquals(creationDoneIndex > creationStartIndex, true);
        assertEquals(ui.messages.filter((message: string) => message === "The Work Record is ready.").length, 1);
        assertEquals(
            ui.messages.some((message: string) =>
                message.includes(`Supersession proposal remains pending: ${PREDECESSOR_RECORD_ID}`) &&
                message.includes("wld wr supersede")
            ),
            true,
        );
    });
});

test("post-verification hosted confirmation applies canonical Work Record supersession", async () => {
    await withRuntimeCommandFixture("validation-work-record-confirm-", async (fixture) => {
        const { records, indexCount, ui } = await runWorkRecordHandoff(fixture, "confirm");
        const predecessor = records.find((record) => record.attrs.recordId === PREDECESSOR_RECORD_ID);
        const successor = records.find((record) => record.attrs.recordId !== PREDECESSOR_RECORD_ID);

        assertEquals(ui.promptSelections, ["confirm"]);
        assertEquals(predecessor?.attrs.status, "superseded");
        assertEquals(predecessor?.attrs.supersededBy, successor?.attrs.recordId);
        assertEquals(successor?.attrs.supersedes, [PREDECESSOR_RECORD_ID]);
        assertEquals(successor?.attrs.supersessionProposal, undefined);
        assertEquals(indexCount, 2);
    });
});

test("post-verification hosted rejection removes the proposal without mutating its predecessor", async () => {
    await withRuntimeCommandFixture("validation-work-record-reject-", async (fixture) => {
        const { records, indexCount, ui } = await runWorkRecordHandoff(fixture, "reject");
        const predecessor = records.find((record) => record.attrs.recordId === PREDECESSOR_RECORD_ID);
        const successor = records.find((record) => record.attrs.recordId !== PREDECESSOR_RECORD_ID);

        assertEquals(ui.promptSelections, ["reject"]);
        assertEquals(successor?.attrs.supersessionProposal, undefined);
        assertEquals(successor?.attrs.supersedes, undefined);
        assertEquals(predecessor?.attrs.status, "approved");
        assertEquals(predecessor?.attrs.supersededBy, undefined);
        assertEquals(indexCount, 1);
    });
});

test("post-verification canceled hosted interaction retains the proposal without canonical mutation", async () => {
    await withRuntimeCommandFixture("validation-work-record-cancel-", async (fixture) => {
        const { records, indexCount, ui } = await runWorkRecordHandoff(fixture, null);
        const predecessor = records.find((record) => record.attrs.recordId === PREDECESSOR_RECORD_ID);
        const successor = records.find((record) => record.attrs.recordId !== PREDECESSOR_RECORD_ID);

        assertEquals(ui.promptSelections, ["canceled"]);
        assertEquals(successor?.attrs.supersessionProposal?.candidates, [{
            recordId: PREDECESSOR_RECORD_ID,
            reason: "The verified implementation replaces the older implementation.",
        }]);
        assertEquals(successor?.attrs.supersedes, undefined);
        assertEquals(predecessor?.attrs.status, "approved");
        assertEquals(predecessor?.attrs.supersededBy, undefined);
        assertEquals(indexCount, 1);
    });
});
