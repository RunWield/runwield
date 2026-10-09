import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadPlan, savePlan } from "../plan-store.js";
import {
    appendEpicManualQaSection,
    getEpicArtifactPath,
    isEpicArtifactPlanName,
    moveEpicArtifactsFromArchive,
    moveEpicArtifactsToArchive,
} from "./epic-artifacts.ts";

async function makeEpicFixture() {
    const projectRoot = await Deno.makeTempDir({ prefix: "epic-artifacts-" });
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

Deno.test("Epic Artifact recognition is exact", () => {
    assertEquals(isEpicArtifactPlanName("epic/manual-qa"), true);
    assertEquals(isEpicArtifactPlanName("epic/manual-qa.md"), true);
    assertEquals(isEpicArtifactPlanName("manual-qa"), false);
    assertEquals(isEpicArtifactPlanName("epic/01-manual-qa-support"), false);
    assertEquals(isEpicArtifactPlanName("epic/deeper/manual-qa"), false);
});

Deno.test("appendEpicManualQaSection preserves user edits on duplicate", async () => {
    const projectRoot = await makeEpicFixture();
    try {
        const args = {
            projectRoot,
            epicPlanName: "epic",
            childPlanName: "epic/01-one",
            childHeading: "01 — One",
            checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Check one",
        };
        await appendEpicManualQaSection(args);
        const artifactPath = getEpicArtifactPath(projectRoot, "epic", "manual-qa.md");
        const checked = (await Deno.readTextFile(artifactPath)).replace("- [ ] Check one", "- [x] Check one");
        await Deno.writeTextFile(artifactPath, checked);

        const result = await appendEpicManualQaSection({
            ...args,
            checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Replacement",
        });

        const after = await Deno.readTextFile(artifactPath);
        assertEquals(result.status, "already_present");
        assertStringIncludes(after, "- [x] Check one");
        assertEquals(after.includes("- [ ] Replacement"), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("appendEpicManualQaSection validates the existing Manual QA checklist shape", async () => {
    const projectRoot = await makeEpicFixture();
    try {
        await assertRejects(
            () =>
                appendEpicManualQaSection({
                    projectRoot,
                    epicPlanName: "epic",
                    childPlanName: "epic/01-one",
                    childHeading: "01 — One",
                    checklistMarkdown: "Wrong heading\n\n- [ ] Check one",
                }),
            Error,
            "Manual QA checklist must start",
        );
        await assertRejects(
            () =>
                appendEpicManualQaSection({
                    projectRoot,
                    epicPlanName: "epic",
                    childPlanName: "epic/01-one",
                    childHeading: "01 — One",
                    checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [x] Already checked",
                }),
            Error,
            "1 to 6 unchecked",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("Epic Artifact moves to archive and back without becoming a Plan", async () => {
    const projectRoot = await makeEpicFixture();
    try {
        const artifactPath = getEpicArtifactPath(projectRoot, "epic", "manual-qa.md");
        await Deno.mkdir(join(projectRoot, "docs", "plans", "epic"), { recursive: true });
        await Deno.writeTextFile(artifactPath, "# QA\n\n- [ ] Check\n");

        const archived = await moveEpicArtifactsToArchive(projectRoot, "epic");
        assertEquals(archived.length, 1);
        assertEquals(
            await Deno.readTextFile(join(projectRoot, "docs", "plans", "archived", "epic", "manual-qa.md")),
            "# QA\n\n- [ ] Check\n",
        );
        assertEquals(await loadPlan(projectRoot, "epic/manual-qa"), null);

        const restored = await moveEpicArtifactsFromArchive(projectRoot, "epic");
        assertEquals(restored.length, 1);
        assertEquals(await Deno.readTextFile(artifactPath), "# QA\n\n- [ ] Check\n");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("Epic Artifact archive move collision leaves both files unchanged", async () => {
    const projectRoot = await makeEpicFixture();
    try {
        const activePath = getEpicArtifactPath(projectRoot, "epic", "manual-qa.md");
        const archivedPath = join(projectRoot, "docs", "plans", "archived", "epic", "manual-qa.md");
        await Deno.mkdir(join(projectRoot, "docs", "plans", "epic"), { recursive: true });
        await Deno.mkdir(join(projectRoot, "docs", "plans", "archived", "epic"), { recursive: true });
        await Deno.writeTextFile(activePath, "active artifact");
        await Deno.writeTextFile(archivedPath, "archived artifact");

        await assertRejects(
            () => moveEpicArtifactsToArchive(projectRoot, "epic"),
            Error,
            "Epic Artifact already exists",
        );

        assertEquals(await Deno.readTextFile(activePath), "active artifact");
        assertEquals(await Deno.readTextFile(archivedPath), "archived artifact");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("Epic Artifact restore move collision leaves both files unchanged", async () => {
    const projectRoot = await makeEpicFixture();
    try {
        const activePath = getEpicArtifactPath(projectRoot, "epic", "manual-qa.md");
        const archivedPath = join(projectRoot, "docs", "plans", "archived", "epic", "manual-qa.md");
        await Deno.mkdir(join(projectRoot, "docs", "plans", "epic"), { recursive: true });
        await Deno.mkdir(join(projectRoot, "docs", "plans", "archived", "epic"), { recursive: true });
        await Deno.writeTextFile(activePath, "active artifact");
        await Deno.writeTextFile(archivedPath, "archived artifact");

        await assertRejects(
            () => moveEpicArtifactsFromArchive(projectRoot, "epic"),
            Error,
            "Epic Artifact already exists",
        );

        assertEquals(await Deno.readTextFile(activePath), "active artifact");
        assertEquals(await Deno.readTextFile(archivedPath), "archived artifact");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});
