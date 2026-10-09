import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { savePlan } from "../plan-store.js";
import { createQaChecklistGeneratedTool } from "./qa-checklist-generated.ts";

const EXTENSION_CONTEXT = {} as ExtensionToolContext;

function text(result: { content: Array<{ type: string; text?: string }> }): string {
    const item = result.content[0];
    return item?.type === "text" ? item.text || "" : "";
}

async function makeRoot() {
    const projectRoot = await Deno.makeTempDir({ prefix: "qa-checklist-tool-" });
    await savePlan(projectRoot, "epic", "# Epic", {
        classification: "PROJECT",
        status: "ready_for_work",
        summary: "Epic",
    });
    await savePlan(projectRoot, "epic/01-one", "# One", {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        parentPlan: "epic",
        summary: "One",
    });
    return projectRoot;
}

Deno.test("qa_checklist_generated records a real Epic child checklist", async () => {
    const projectRoot = await makeRoot();
    try {
        const tool = createQaChecklistGeneratedTool({
            projectRoot,
            epicPlanName: "epic",
            childPlanName: "epic/01-one",
            childHeading: "01 — One",
        });

        const result = await tool.execute(
            "call",
            {
                checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Check one",
            },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );

        assertEquals(result.details?.outcome, "recorded");
        assertStringIncludes(text(result), "docs/plans/epic/manual-qa.md");
        assertStringIncludes(await Deno.readTextFile(`${projectRoot}/docs/plans/epic/manual-qa.md`), "Check one");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("qa_checklist_generated rejects invalid content without throwing", async () => {
    const projectRoot = await makeRoot();
    try {
        const tool = createQaChecklistGeneratedTool({
            projectRoot,
            epicPlanName: "epic",
            childPlanName: "epic/01-one",
            childHeading: "01 — One",
        });

        const result = await tool.execute(
            "call",
            {
                checklistMarkdown: "Wrong heading\n\n- [ ] Check one",
            },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );

        assertEquals(result.details?.outcome, "rejected");
        assertStringIncludes(text(result), "was not recorded");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});
