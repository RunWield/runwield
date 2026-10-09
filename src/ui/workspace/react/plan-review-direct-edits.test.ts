import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import {
    buildRunWieldDirectEditPanel,
    buildRunWieldDirectEditsFeedback,
    composeRunWieldPlanFeedback,
} from "./plan-review-direct-edits.ts";

const BASE_PLAN = "# Plan\n\nUse the old approach.\n";
const EDITED_PLAN = "# Plan\n\nUse the revised approach.\n";

test("direct Plan edits produce a visible sidebar diff", () => {
    const [panel] = buildRunWieldDirectEditPanel(BASE_PLAN, EDITED_PLAN);

    assertEquals(panel.title, "Direct Plan edits");
    assertEquals(panel.added, 1);
    assertEquals(panel.removed, 1);
    assertStringIncludes(panel.description || "", "Will be applied to the Plan");
    assertStringIncludes(panel.diffText, "-Use the old approach.");
    assertStringIncludes(panel.diffText, "+Use the revised approach.");
    assertEquals(buildRunWieldDirectEditPanel(BASE_PLAN, BASE_PLAN), []);
});

test("direct Plan edit feedback says the edits are already applied", () => {
    const editsOnly = composeRunWieldPlanFeedback("No changes detected.", BASE_PLAN, EDITED_PLAN);
    assertStringIncludes(editsOnly, "# Direct Plan Edits");
    assertStringIncludes(editsOnly, "already applied these changes");
    assertEquals(editsOnly.includes("No changes detected."), false);

    const combined = composeRunWieldPlanFeedback("# Plan Feedback\n\nClarify the goal.", BASE_PLAN, EDITED_PLAN);
    assertStringIncludes(combined, "# Direct Plan Edits");
    assertStringIncludes(combined, "# Plan Feedback");
    assertEquals(buildRunWieldDirectEditsFeedback(BASE_PLAN, BASE_PLAN), "");
});
