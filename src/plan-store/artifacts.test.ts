import { seedPlan } from "../shared/testing/plan-state-fixture.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan } from "../shared/testing/plan-query-fixture.ts";

import { moveCheckoutEpicArtifacts } from "@runwield/plans/artifact-files";
import { openPlanStoreForCheckout, StalePlanWriteError, workflowEpicArtifacts } from "./index.ts";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { plans } from "@runwield/plans";
import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";

async function withEpicFixture(run: (root: string) => Promise<void>, epicId?: string) {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "epic-artifacts-"));
    try {
        await withRetainedPlanFixture(projectRoot, async () => {
            await seedPlan(projectRoot, "epic", "# Epic", {
                planId: epicId,
                classification: "PROJECT",
                status: "ready_for_work",
                summary: "Epic",
            });
            await seedPlan(projectRoot, "epic/01-one", "# One", {
                classification: "PLANNED_CHANGE",
                status: "reviewed",
                parentPlan: "epic",
                summary: "One",
            });
            await run(projectRoot);
        });
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
}

test("Manual QA append preserves user edits on duplicate", async () => {
    await withEpicFixture(async (projectRoot) => {
        const artifacts = await workflowEpicArtifacts(projectRoot, "epic");
        const args = {
            childHeading: "01 — One",
            checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Check one",
        };
        await artifacts.appendManualQaSection("epic/01-one", args);
        const artifactPath = join(projectRoot, "docs", "plans", "epic", "manual-qa.md");
        const checked = (await fsReadFile(artifactPath, "utf8")).replace("- [ ] Check one", "- [x] Check one");
        await fsWriteFile(artifactPath, checked);

        const result = await artifacts.appendManualQaSection("epic/01-one", {
            ...args,
            checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Replacement",
        });

        const after = await fsReadFile(artifactPath, "utf8");
        assertEquals(result.status, "already_present");
        assertStringIncludes(after, "- [x] Check one");
        assertEquals(after.includes("- [ ] Replacement"), false);
    });
});

test("Manual QA append validates the checklist shape", async () => {
    await withEpicFixture(async (projectRoot) => {
        const artifacts = await workflowEpicArtifacts(projectRoot, "epic");
        await assertRejects(
            () =>
                artifacts.appendManualQaSection("epic/01-one", {
                    childHeading: "01 — One",
                    checklistMarkdown: "Wrong heading\n\n- [ ] Check one",
                }),
            Error,
            "Manual QA checklist must start",
        );
        await assertRejects(
            () =>
                artifacts.appendManualQaSection("epic/01-one", {
                    childHeading: "01 — One",
                    checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [x] Already checked",
                }),
            Error,
            "1 to 6 unchecked",
        );
    });
});

test("Epic Artifact moves to archive and back without becoming a Plan", async () => {
    await withEpicFixture(async (projectRoot) => {
        const artifactPath = join(projectRoot, "docs", "plans", "epic", "manual-qa.md");
        await fsMkdir(join(projectRoot, "docs", "plans", "epic"), { recursive: true });
        await fsWriteFile(artifactPath, "# QA\n\n- [ ] Check\n");

        const archived = await moveCheckoutEpicArtifacts(projectRoot, "epic", true);
        assertEquals(archived.length, 1);
        assertEquals(
            await fsReadFile(join(projectRoot, "docs", "plans", "archived", "epic", "manual-qa.md"), "utf8"),
            "# QA\n\n- [ ] Check\n",
        );
        assertEquals(await loadPlan(projectRoot, "epic/manual-qa"), null);

        const restored = await moveCheckoutEpicArtifacts(projectRoot, "epic", false);
        assertEquals(restored.length, 1);
        assertEquals(await fsReadFile(artifactPath, "utf8"), "# QA\n\n- [ ] Check\n");
    });
});

test("project-bound artifact access uses the Epic ID and its current revision", async () => {
    const fixture = await packageFixture();
    const other = await packageFixture();
    try {
        const store = openPlanStoreForCheckout(fixture.root)!;
        const foreign = openPlanStoreForCheckout(other.root)!;
        const epic = await store.create({
            planName: "epic",
            contextMarkdown: "# Epic",
            definition: { classification: "PROJECT" },
        });
        const namedAlias = await foreign.create({
            planName: epic.planId,
            contextMarkdown: "# Different Epic",
            definition: { classification: "PROJECT" },
        });
        assertEquals(await store.artifacts.read(epic.planId, "integration-report.md"), null);
        await assertRejects(() => foreign.artifacts.read(epic.planId, "integration-report.md"), Error);

        const first = await store.artifacts.save(
            epic.planId,
            "integration-report.md",
            "\ufeff# First report\n",
            epic.revision,
        );
        assertEquals(first.relativePath, `plans/${epic.planId}/integration-report.md`);
        assertEquals(
            first,
            await openPlanStoreForCheckout(fixture.root)!.artifacts.read(epic.planId, "integration-report.md"),
        );
        assertEquals(first.body, "\ufeff# First report\n");

        const revised = await store.artifacts.save(
            epic.planId,
            "integration-report.md",
            "# Revised report",
            first.revision,
        );
        await assertRejects(
            () => store.artifacts.save(epic.planId, "integration-report.md", "# Stale report", first.revision),
            StalePlanWriteError,
        );
        assertEquals(await store.artifacts.read(epic.planId, "integration-report.md"), revised);
        assertEquals(await foreign.artifacts.read(namedAlias.planId, "integration-report.md"), null);
    } finally {
        await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
});

test("retained artifact revisions reject edits from a stale checkout read", async () => {
    await withEpicFixture(async (root) => {
        const id = plans.identity.parse((await loadPlan(root, "epic"))?.attrs.planId)!;
        const { artifacts } = openPlanStoreForCheckout(root)!;
        const saved = await artifacts.save(id, "integration-report.md", "\ufeff# First report\n");
        assertEquals((await artifacts.read(id, "integration-report.md"))?.body, saved.body);
        const physicalPath = join(root, "docs", "plans", "epic", "integration-report.md");
        await fsWriteFile(physicalPath, "# User edit\n");
        await assertRejects(
            () => artifacts.save(id, "integration-report.md", "# Stale report", saved.revision),
            StalePlanWriteError,
        );
        assertEquals((await artifacts.read(id, "integration-report.md"))?.body, "# User edit\n");
    }, "retained.epic");
});

test("retained QA does not write to an Epic that reused the selected name", async () => {
    await withEpicFixture(async (root) => {
        const artifacts = await workflowEpicArtifacts(root, "epic");
        await fsWriteFile(
            join(root, "docs", "plans", "epic.md"),
            plans.documents.create("# Replacement Epic", { planId: "epic.replacement", classification: "PROJECT" }),
        );

        await assertRejects(
            () =>
                artifacts.appendManualQaSection("epic/01-one", {
                    childHeading: "Check",
                    checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Verify",
                }),
            Error,
            "changed before QA preparation",
        );
        await assertRejects(
            () => fsReadFile(join(root, "docs", "plans", "epic", "manual-qa.md"), "utf8"),
            Error,
            "ENOENT",
        );
    }, "epic.original");
});
