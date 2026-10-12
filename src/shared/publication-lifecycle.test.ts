import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { buildWorkRecordIndexDocument } from "./work-records/index-adapter.ts";
import { join } from "@std/path";
import { defineGitFixture, git } from "./git-test-fixture.ts";
import { parsePlanFrontMatter } from "../plan-store.js";
import { formatWorkRecordMarkdown, parseWorkRecordMarkdown } from "./work-records/markdown.js";
import {
    finalizeLocalPublicationLifecycle,
    finalizePublicationLifecycle,
    hasFinalizedPublicationLifecycle,
    recoverLocalPublicationLifecycle,
} from "./publication-lifecycle.ts";

const planId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const planPath = "docs/plans/feature.md";
const recordPath = "docs/work-records/feature.md";
const fixture = defineGitFixture(async (root) => {
    await Deno.mkdir(join(root, "docs/plans"), { recursive: true });
    await Deno.mkdir(join(root, "docs/work-records"), { recursive: true });
    await Deno.writeTextFile(
        join(root, planPath),
        `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: reviewed\nworkRecord:\n  status: generated\n  recordId: ${recordId}\n  path: ${recordPath}\n---\n# Feature\n`,
    );
    await Deno.writeTextFile(
        join(root, recordPath),
        formatWorkRecordMarkdown(
            {
                kind: "work_record",
                recordId,
                status: "pending_verification",
                scope: "planned_change",
                origin: "internal",
                completionMode: "verified",
                createdAt: "2026-01-01T00:00:00.000Z",
                provenance: { sourcePlans: [planId] },
            },
            "# Feature\n\n## Summary\n\nAdded a feature; publication pending. Full test suite has not run.\n\n## Deferred Work\n\nKeyboard navigation remains deferred.\n",
        ),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Reviewed candidate with pending record"]);
});

for (const checkedOut of [true, false]) {
    Deno.test(`local delivery finalizes exactly its target branch (checked out: ${checkedOut})`, async () => {
        const root = await fixture.checkout();
        try {
            const candidate = await git(root, ["rev-parse", "HEAD"]);
            const target = checkedOut ? "main" : "release/next";
            if (!checkedOut) await git(root, ["branch", target]);
            const before = await Deno.readTextFile(join(root, planPath));
            await Deno.writeTextFile(join(root, "personal-note.txt"), "Keep me\n");
            const delivered = await finalizeLocalPublicationLifecycle(root, target, "feature", candidate, [planPath]);
            assert(delivered !== candidate);
            assertEquals(
                parsePlanFrontMatter(await git(root, ["show", `${target}:${planPath}`])).attrs.status,
                "verified",
            );
            assertEquals(
                parseWorkRecordMarkdown(await git(root, ["show", `${target}:${recordPath}`])).attrs.status,
                "approved",
            );
            const finalized = parseWorkRecordMarkdown(await git(root, ["show", `${target}:${recordPath}`]));
            assertStringIncludes(finalized.summary, `Delivery destination: \`${target}\``);
            assertEquals(finalized.summary.includes("publication pending"), false);
            assertStringIncludes(
                finalized.body,
                "> Added a feature; publication pending. Full test suite has not run.",
            );
            assertStringIncludes(finalized.body, "> Keyboard navigation remains deferred.");
            assertStringIncludes(buildWorkRecordIndexDocument(finalized), "> Keyboard navigation remains deferred.");
            assertStringIncludes(finalized.summary, "no additional or full test suite is claimed");
            assertEquals(
                await hasFinalizedPublicationLifecycle(
                    root,
                    delivered,
                    "feature",
                    planId,
                    candidate,
                    [planPath],
                    target,
                ),
                true,
            );
            assertEquals(
                await hasFinalizedPublicationLifecycle(root, candidate, "feature", planId, candidate, [planPath]),
                false,
            );
            assertEquals(await Deno.readTextFile(join(root, "personal-note.txt")), "Keep me\n");
            if (!checkedOut) {
                assertEquals(await git(root, ["rev-parse", "main"]), candidate);
                assertEquals(await Deno.readTextFile(join(root, planPath)), before);
            }
            assertEquals(
                await finalizeLocalPublicationLifecycle(root, target, "feature", candidate, [planPath]),
                delivered,
            );
        } finally {
            await Deno.remove(root, { recursive: true });
        }
    });
}

Deno.test("metadata recovery settles an interrupted checkout refresh and preserves subsequent user edits", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        await finalizeLocalPublicationLifecycle(root, "main", "feature", candidate, [planPath]);
        // Simulate the filesystem/index state immediately after update-ref but before refresh.
        await git(root, ["restore", "--source=HEAD^", "--staged", "--worktree", "--", planPath, recordPath]);
        await recoverLocalPublicationLifecycle(root, "main", candidate);
        assertEquals(await git(root, ["status", "--porcelain"]), "");
        const edited = `${await Deno.readTextFile(join(root, recordPath))}\nUser note\n`;
        await Deno.writeTextFile(join(root, recordPath), edited);
        await assertRejects(() => recoverLocalPublicationLifecycle(root, "main", candidate), Error, "Preserved edited");
        assertEquals(await Deno.readTextFile(join(root, recordPath)), edited);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("record changes outside the sealed candidate cannot be approved and leave Plan untouched", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        const plan = await Deno.readTextFile(join(root, planPath));
        await Deno.writeTextFile(
            join(root, recordPath),
            `${await Deno.readTextFile(join(root, recordPath))}\nUnreviewed claim\n`,
        );
        await assertRejects(
            () => finalizePublicationLifecycle(root, "feature", candidate, [planPath]),
            Error,
            "outside its sealed publication",
        );
        assertEquals(await Deno.readTextFile(join(root, planPath)), plan);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("already published legacy metadata still proves delivery without rewriting history", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        const plan = await Deno.readTextFile(join(root, planPath));
        const record = parseWorkRecordMarkdown(await Deno.readTextFile(join(root, recordPath)));
        await Deno.writeTextFile(join(root, planPath), plan.replace("status: reviewed", "status: verified"));
        await Deno.writeTextFile(
            join(root, recordPath),
            formatWorkRecordMarkdown({ ...record.attrs, status: "approved" }, record.body),
        );
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "legacy publication"]);
        const published = await git(root, ["rev-parse", "HEAD"]);
        assert(
            await hasFinalizedPublicationLifecycle(root, published, "feature", planId, candidate, [planPath], "main"),
        );
        assertEquals(await git(root, ["rev-parse", "HEAD"]), published);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
