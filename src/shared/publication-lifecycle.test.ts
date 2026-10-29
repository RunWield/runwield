import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
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
    await fsMkdir(join(root, "docs/plans"), { recursive: true });
    await fsMkdir(join(root, "docs/work-records"), { recursive: true });
    await fsWriteFile(
        join(root, planPath),
        `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: reviewed\nworkRecord:\n  status: generated\n  recordId: ${recordId}\n  path: ${recordPath}\n---\n# Feature\n`,
    );
    await fsWriteFile(
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
            "# Feature\n\n## Summary\n\nSearch results use a local cache.\n\n## Out of Scope\n\nThis work does not include keyboard navigation.\n",
        ),
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Reviewed candidate with pending record"]);
});

for (const autocrlf of [false, true]) {
    for (const checkedOut of [true, false]) {
        test(`local delivery finalizes exactly its target branch (checked out: ${checkedOut}, autocrlf: ${autocrlf})`, async () => {
            const root = await fixture.checkout();
            try {
                await git(root, ["config", "core.autocrlf", String(autocrlf)]);
                const candidate = await git(root, ["rev-parse", "HEAD"]);
                const target = checkedOut ? "main" : "release/next";
                if (!checkedOut) await git(root, ["branch", target]);
                const before = await fsReadFile(join(root, planPath), "utf8");
                await fsWriteFile(join(root, "personal-note.txt"), "Keep me\n");
                const delivered = await finalizeLocalPublicationLifecycle(root, target, "feature", candidate, [
                    planPath,
                ]);
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
                const sealed = parseWorkRecordMarkdown(await git(root, ["show", `${candidate}:${recordPath}`]));
                assertEquals(finalized.body, sealed.body);
                assertEquals(finalized.body.includes(candidate), false);
                assertEquals(finalized.body.includes("Historical pre-publication notes"), false);
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
                assertEquals(await fsReadFile(join(root, "personal-note.txt"), "utf8"), "Keep me\n");
                if (!checkedOut) {
                    assertEquals(await git(root, ["rev-parse", "main"]), candidate);
                    assertEquals(await fsReadFile(join(root, planPath), "utf8"), before);
                }
                assertEquals(
                    await finalizeLocalPublicationLifecycle(root, target, "feature", candidate, [planPath]),
                    delivered,
                );
            } finally {
                await fsRm(root, { recursive: true });
            }
        });
    }
}

for (const secondWorktree of [false, true]) {
    for (const staged of [false, true]) {
        for (const path of [planPath, recordPath]) {
            test(`local metadata edits pause before moving the target (second worktree: ${secondWorktree}, staged: ${staged}, path: ${path})`, async () => {
                const root = await fixture.checkout();
                try {
                    const candidate = await git(root, ["rev-parse", "HEAD"]);
                    const checkout = secondWorktree ? join(root, "target checkout") : root;
                    const target = secondWorktree ? "release/next" : "main";
                    if (secondWorktree) await git(root, ["worktree", "add", "-b", target, checkout]);
                    const edited = `${await fsReadFile(join(checkout, path), "utf8")}\nUser note\n`;
                    await fsWriteFile(join(checkout, path), edited);
                    if (staged) await git(checkout, ["add", "--", path]);
                    const index = await git(checkout, ["show", `:${path}`]);
                    const failure = await assertRejects(
                        () => finalizeLocalPublicationLifecycle(root, target, "feature", candidate, [planPath]),
                        Error,
                        "Preserved edited delivery metadata",
                    );
                    assertEquals(await git(root, ["rev-parse", `refs/heads/${target}`]), candidate);
                    assertEquals(await fsReadFile(join(checkout, path), "utf8"), edited);
                    assertEquals(await git(checkout, ["show", `:${path}`]), index);
                    assert("mergeFailureKind" in failure);
                    assertEquals(failure.mergeFailureKind, "primary_checkout_dirty");
                    assert("blockingPaths" in failure);
                    assertEquals(failure.blockingPaths, [path]);
                } finally {
                    await fsRm(root, { recursive: true });
                }
            });
        }
    }
}

test("local delivery lists all metadata blockers through retries", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        for (const path of [planPath, recordPath]) {
            await fsWriteFile(join(root, path), `${await fsReadFile(join(root, path), "utf8")}\nUser note\n`);
        }
        await git(root, ["add", "--", planPath]);
        for (let attempt = 0; attempt < 2; attempt++) {
            const failure = await assertRejects(
                () => finalizeLocalPublicationLifecycle(root, "main", "feature", candidate, [planPath]),
                Error,
                "Preserved edited delivery metadata",
            );
            assert("blockingPaths" in failure);
            assertEquals(failure.blockingPaths, [planPath, recordPath]);
            assertEquals(await git(root, ["rev-parse", "HEAD"]), candidate);
            assertStringIncludes(await fsReadFile(join(root, planPath), "utf8"), "User note");
            assertStringIncludes(await fsReadFile(join(root, recordPath), "utf8"), "User note");
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("local delivery refreshes the target branch in a second worktree", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        const checkout = join(root, "target checkout");
        await git(root, ["worktree", "add", "-b", "release/next", checkout]);
        const delivered = await finalizeLocalPublicationLifecycle(root, "release/next", "feature", candidate, [
            planPath,
        ]);
        assert(delivered !== candidate);
        assertEquals(await git(checkout, ["rev-parse", "HEAD"]), delivered);
        assertEquals(await git(checkout, ["status", "--porcelain"]), "");
        assertEquals(parsePlanFrontMatter(await fsReadFile(join(checkout, planPath), "utf8")).attrs.status, "verified");
        assertEquals(await git(root, ["rev-parse", "HEAD"]), candidate);
        assertEquals(
            await finalizeLocalPublicationLifecycle(root, "release/next", "feature", candidate, [planPath]),
            delivered,
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("metadata recovery settles an interrupted checkout refresh and preserves subsequent user edits", async () => {
    const root = await fixture.checkout();
    try {
        await git(root, ["config", "core.autocrlf", "true"]);
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        await finalizeLocalPublicationLifecycle(root, "main", "feature", candidate, [planPath]);
        // Simulate the filesystem/index state immediately after update-ref but before refresh.
        await git(root, ["restore", "--source=HEAD^", "--staged", "--worktree", "--", planPath, recordPath]);
        await recoverLocalPublicationLifecycle(root, "main", candidate);
        assertEquals(await git(root, ["status", "--porcelain"]), "");
        const edited = `${await fsReadFile(join(root, recordPath), "utf8")}\nUser note\n`;
        await fsWriteFile(join(root, recordPath), edited);
        await assertRejects(() => recoverLocalPublicationLifecycle(root, "main", candidate), Error, "Preserved edited");
        assertEquals(await fsReadFile(join(root, recordPath), "utf8"), edited);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("record changes outside the sealed candidate cannot be approved and leave Plan untouched", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        const plan = await fsReadFile(join(root, planPath), "utf8");
        await fsWriteFile(
            join(root, recordPath),
            `${await fsReadFile(join(root, recordPath), "utf8")}\nUnreviewed claim\n`,
        );
        await assertRejects(
            () => finalizePublicationLifecycle(root, "feature", candidate, [planPath]),
            Error,
            "outside its sealed publication",
        );
        assertEquals(await fsReadFile(join(root, planPath), "utf8"), plan);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("already published legacy metadata still proves delivery without rewriting history", async () => {
    const root = await fixture.checkout();
    try {
        const candidate = await git(root, ["rev-parse", "HEAD"]);
        const plan = await fsReadFile(join(root, planPath), "utf8");
        const record = parseWorkRecordMarkdown(await fsReadFile(join(root, recordPath), "utf8"));
        await fsWriteFile(join(root, planPath), plan.replace("status: reviewed", "status: verified"));
        await fsWriteFile(
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
        await fsRm(root, { recursive: true });
    }
});

for (const edited of [false, true]) {
    test(`publication retry preserves an exact legacy wrapper (edited: ${edited})`, async () => {
        const root = await fixture.checkout();
        try {
            const candidate = await git(root, ["rev-parse", "HEAD"]);
            const original = parseWorkRecordMarkdown(await fsReadFile(join(root, recordPath), "utf8"));
            const legacyBody = [
                `# ${original.title}`,
                "",
                "## Summary",
                "",
                "Delivery metadata has been finalized for this validated change.",
                `Candidate containing the implementation and draft record: \`${candidate}\`.`,
                "Delivery destination: `main`.",
                "This record accompanies the delivery commit. The publication receipt confirms whether that commit reached its destination; this metadata alone does not prove a remote push or a merge into another branch.",
                "",
                "Validation scope is the configured workflow gate. See the delivery card's test results for the actual command output; no additional or full test suite is claimed here.",
                "",
                "## Historical pre-publication notes",
                "",
                "The recorder draft below is preserved verbatim as historical context. Its publication-pending and outstanding-validation statements describe the earlier snapshot, not the current delivery status. Implementation details, deviations and deferred work remain available here; consult the delivery evidence for final validation outcomes.",
                "",
                ...original.body.split("\n").map((line) => `> ${line}`),
                ...(edited ? ["Unreviewed claim."] : []),
            ].join("\n");
            const legacy = formatWorkRecordMarkdown({ ...original.attrs, status: "approved" }, legacyBody);
            await fsWriteFile(join(root, recordPath), legacy);
            if (edited) {
                await assertRejects(
                    () => finalizePublicationLifecycle(root, "feature", candidate, [planPath], "main"),
                    Error,
                    "outside its sealed publication",
                );
                assertEquals(
                    parsePlanFrontMatter(await fsReadFile(join(root, planPath), "utf8")).attrs.status,
                    "reviewed",
                );
            } else {
                assertEquals(await finalizePublicationLifecycle(root, "feature", candidate, [planPath], "main"), [
                    planPath,
                ]);
                assertEquals(await finalizePublicationLifecycle(root, "feature", candidate, [planPath], "main"), []);
                await git(root, ["add", "docs"]);
                await git(root, ["commit", "-m", "Historical wrapper publication"]);
                const published = await git(root, ["rev-parse", "HEAD"]);
                assertEquals(
                    await hasFinalizedPublicationLifecycle(
                        root,
                        published,
                        "feature",
                        planId,
                        candidate,
                        [planPath],
                        "main",
                    ),
                    true,
                );
            }
            assertEquals(await fsReadFile(join(root, recordPath), "utf8"), legacy);
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}
