import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    applyTutorialContextUpdate,
    normalizeTutorialContext,
    readPersistedTutorialContext,
    recordTutorialContext,
    TUTORIAL_CONTEXT_CUSTOM_TYPE,
} from "./tutorial-context-session.ts";

/** @param {Array<Record<string, unknown>>} entries */
function makeSessionManager(entries = []) {
    return {
        getBranch: () => entries,
        /** @param {string} customType @param {unknown} data */
        appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    };
}

const ENABLED_CONTEXT = {
    version: 1,
    guidanceEnabled: true,
    shownExplanationIds: ["welcome", "plans"],
    recapShown: false,
    planId: null,
};

test("tutorial context normalizes and deduplicates explanation ids", () => {
    assertEquals(
        normalizeTutorialContext({
            ...ENABLED_CONTEXT,
            shownExplanationIds: [" welcome ", "plans", "welcome", ""],
            planId: " plan-1 ",
        }),
        {
            ...ENABLED_CONTEXT,
            shownExplanationIds: ["welcome", "plans"],
            planId: "plan-1",
        },
    );
    assertEquals(
        applyTutorialContextUpdate(ENABLED_CONTEXT, {
            guidanceEnabled: false,
            shownExplanationIds: ["plans", "plans"],
            recapShown: true,
        }),
        {
            version: 1,
            guidanceEnabled: false,
            shownExplanationIds: ["plans"],
            recapShown: true,
            planId: null,
        },
    );
});

test("tutorial context latest valid entry wins and duplicate records are suppressed", () => {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const manager = makeSessionManager(entries);
    recordTutorialContext(manager, ENABLED_CONTEXT);
    recordTutorialContext(manager, ENABLED_CONTEXT);
    recordTutorialContext(manager, { ...ENABLED_CONTEXT, guidanceEnabled: false, recapShown: true });

    assertEquals(entries.length, 2);
    assertEquals(entries[0].customType, TUTORIAL_CONTEXT_CUSTOM_TYPE);
    assertEquals(readPersistedTutorialContext(manager), {
        ...ENABLED_CONTEXT,
        guidanceEnabled: false,
        recapShown: true,
    });
});

test("tutorial context fails closed for unsupported or invalid latest matching entry", () => {
    const older = { type: "custom", customType: TUTORIAL_CONTEXT_CUSTOM_TYPE, data: ENABLED_CONTEXT };
    assertEquals(
        readPersistedTutorialContext(makeSessionManager([
            older,
            { type: "custom", customType: TUTORIAL_CONTEXT_CUSTOM_TYPE, data: { ...ENABLED_CONTEXT, version: 2 } },
        ])),
        null,
    );
    assertEquals(
        readPersistedTutorialContext(makeSessionManager([
            older,
            {
                type: "custom",
                customType: TUTORIAL_CONTEXT_CUSTOM_TYPE,
                data: { ...ENABLED_CONTEXT, shownExplanationIds: ["ok", 1] },
            },
        ])),
        null,
    );
});

test("tutorial context is absent for legacy transcripts and rejects incomplete data", () => {
    assertEquals(
        readPersistedTutorialContext(makeSessionManager([
            { type: "custom", customType: "runwield.workflow_context", data: { planName: "legacy" } },
        ])),
        null,
    );
    assertEquals(normalizeTutorialContext({ guidanceEnabled: true }), null);
    assertEquals(recordTutorialContext(makeSessionManager(), { ...ENABLED_CONTEXT, recapShown: "yes" }), null);
});
