import { test } from "node:test";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, read } from "../testing/plan-package-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { openProjectPlanStore } from "../../plan-store/index.ts";
import { addEntry, findById, pruneEntry } from "../worktree-registry.ts";

test("pruned publication can resume only with a matching retained delivery receipt", async () => {
    const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
    const { openPublication } = await import("@runwield/workflow/publication-runtime");
    const f = await publicationFixture(true);
    try {
        const stopped = await f.drive("candidate_receipt");
        equal(stopped.code, 86, stopped.text);
        const entry = await findById(f.root, f.config.attemptId);
        const candidate = entry?.publication;
        ok(candidate?.packageInput);
        const publication = openPublication(f.root);
        const reference = publication.attempt(candidate.attemptId);
        const now = new Date().toISOString();
        const claimedCleanup = {
            ...candidate,
            phase: "cleanup_complete" as const,
            copiesPrepared: true,
            planPaths: [],
            targetBaseCommit: candidate.targetHeadAtSeal,
            integrationCommit: candidate.validatedCommit,
            publicationMode: "local" as const,
            publishedCommit: candidate.validatedCommit,
            verifiedAt: now,
            cleanedAt: now,
        };
        await pruneEntry(f.root, candidate.attemptId);
        equal(await reference.load(), null);
        await f.scope(async () => {
            await rejects(publication.resume(claimedCleanup).verify(), /no matching delivery receipt/);
        });
        equal((await read(f.identity)).metadata.workflow?.delivery, undefined);
        ok((await fs.stat(candidate.executionCwd)).isDirectory());

        ok(entry);
        await addEntry(f.root, entry);
        const settled = await f.drive("package_settlement");
        equal(settled.code, 86, settled.text);
        const verified = await reference.load();
        ok(verified);
        await f.scope(async () => {
            const cleanup = await publication.resume(verified).cleanup();
            equal(cleanup.complete, true);
            equal(await reference.load(), null);
            deepEqual(await publication.resume(cleanup.attempt).verify(), cleanup.attempt);
            await rejects(
                publication.resume({ ...cleanup.attempt, publishedCommit: candidate.targetHeadAtSeal }).verify(),
                /Package publication no longer owns this execution/,
            );
        });
    } finally {
        await f.cleanup();
    }
});

test("copy preparation refuses foreign or stale publication records before changing the checkout", async () => {
    const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
    const { openPublication } = await import("@runwield/workflow/publication-runtime");
    const otherRoot = await fs.mkdtemp(join(tmpdir(), "foreign-publication-"));
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("candidate_receipt")).code, 86);
        const publication = openPublication(f.root);
        const attempt = await publication.attempt(f.workflow.worktreeId!).load();
        ok(attempt?.packageInput);
        await rejects(openPublication(otherRoot).resume(attempt).commitCopies(), /different project/);
        await rejects(publication.resume({ ...attempt, executionCwd: f.root }).commitCopies(), /different project/);
        const current = await publication.resume(attempt).recordFailure({ kind: "interrupted", message: "Resume me." });
        await rejects(publication.resume(attempt).commitCopies(), /changed before its copies/);
        equal(await git(attempt.executionCwd, ["status", "--porcelain"]), "");
        equal(await git(attempt.executionCwd, ["rev-parse", "HEAD"]), attempt.validatedCommit);
        deepEqual(await publication.attempt(attempt.attemptId).load(), current);
    } finally {
        await f.cleanup();
        await fs.rm(otherRoot, { recursive: true });
    }
});

for (const plans of [false, true]) {
    test(`one copies commit composes prepared Work Record and Plan copies ${plans}`, async () => {
        const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
        const f = await publicationFixture(plans, [
            { kind: "work-record", path: "docs/work-records/prepared.md", text: "# Prepared record\n" },
        ]);
        try {
            const result = await f.drive();
            equal(result.code, 0, result.text);
            const history = await git(f.remote, ["log", "--format=%B", "main"]);
            equal(history.split("RunWield-Publication-Attempt:").length - 1, 1);
            equal(await git(f.remote, ["show", "main:docs/work-records/prepared.md"]), "# Prepared record");
            const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
            const commits = (await git(f.remote, ["rev-list", `${receipt.validatedCommit}..main`])).split("\n");
            const copiesCommit = commits[commits.length - 1];
            const changed = (
                await git(f.remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", copiesCommit])
            ).split("\n");
            equal(changed.length, plans ? 3 : 1);
            ok(changed.every((path) => path.startsWith("docs/")));
            equal(await git(f.remote, ["show", `${copiesCommit}^:code.txt`]), "code");
        } finally {
            await f.cleanup();
        }
    });
}

test("sealed copy policy and destination survive reused name, live edits and target advancement", async () => {
    const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
    const { renamePlanPackage } = await import("../../plan-store/packages.ts");
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("candidate_receipt")).code, 86);
        const before = await read(f.identity);
        const source = before.metadata.workflow!.publication!;
        await renamePlanPackage(f.identity, before.metadata.planId, before.metadata.revision, "renamed");
        const replacement = await create(f.identity, { planId: "replacement", name: "one" });
        const renamed = await read(f.identity);
        await fs.writeFile(join(renamed.path, "context.md"), "# Preserve my new draft\n");
        f.config.packageSelection.deliveryCopies = {
            plans: false,
            workRecords: [{ kind: "work-record", path: "docs/work-records/new.md", text: "not sealed" }],
        };
        await fs.writeFile(join(f.root, "other.txt"), "another delivery\n");
        await git(f.root, ["add", "other.txt"]);
        await git(f.root, ["commit", "-m", "advance target"]);
        await git(f.root, ["push", "origin", "main"]);
        const result = await f.drive();
        equal(result.code, 0, result.text);
        equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# A Plan\n\nProse — 世界");
        equal(await git(f.remote, ["ls-tree", "main", "--", "docs/plans/renamed", "docs/work-records/new.md"]), "");
        equal((await read(f.identity)).metadata.workflow?.delivery?.source.digest, source.digest);
        deepEqual((await read(f.identity, "replacement")).metadata, replacement.metadata);
        equal(await fs.readFile(join(renamed.path, "context.md"), "utf8"), "# Preserve my new draft\n");
        equal(
            (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
            1,
        );
    } finally {
        await f.cleanup();
    }
});

for (const issue of ["escape", "duplicate", "target-collision"] as const) {
    test(`copy ${issue} refuses, preserves unrelated bytes and resumes after repair`, async () => {
        const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
        const f = await publicationFixture(true);
        try {
            if (issue === "escape")
                f.config.packageSelection.deliveryCopies!.workRecords = [
                    { kind: "work-record", path: "docs/work-records/../../escape.md", text: "unsafe" },
                ];
            if (issue === "duplicate")
                f.config.packageSelection.deliveryCopies!.workRecords = [1, 2].map(() => ({
                    kind: "work-record",
                    path: "docs/work-records/duplicate.md",
                    text: "duplicate",
                }));
            if (issue === "target-collision") {
                equal((await f.drive("candidate_receipt")).code, 86);
                await fs.mkdir(join(f.root, "docs/plans/one"), { recursive: true });
                await fs.writeFile(join(f.root, "docs/plans/one/context.md"), "# Unrelated target document\n");
                await git(f.root, ["add", "docs/plans/one/context.md"]);
                await git(f.root, ["commit", "-m", "independent target document"]);
                await git(f.root, ["push", "origin", "main"]);
            }
            await fs.writeFile(join(f.p.path, "context.md"), "# Surviving editor draft\n");
            // Seal only after exact reviewed bytes: edits made after a failed pre-seal policy check must be restored first.
            if (issue !== "target-collision")
                await fs.writeFile(join(f.p.path, "context.md"), "# A Plan\n\nProse — 世界\n");
            const refused = await f.drive();
            ok(refused.code !== 0, refused.text);
            equal((await read(f.identity)).metadata.definition.status, "reviewed");
            ok((await read(f.identity)).metadata.workflow?.attempt);
            if (issue === "target-collision") {
                equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# Unrelated target document");
                await git(f.root, ["rm", "docs/plans/one/context.md"]);
                await git(f.root, ["commit", "-m", "move unrelated document away"]);
                await git(f.root, ["push", "origin", "main"]);
            } else f.config.packageSelection.deliveryCopies!.workRecords = [];
            const result = await f.drive();
            equal(result.code, 0, result.text);
            equal((await read(f.identity)).metadata.definition.status, "verified");
            equal(
                await fs.readFile(join(f.p.path, "context.md"), "utf8"),
                issue === "target-collision" ? "# Surviving editor draft\n" : "# A Plan\n\nProse — 世界\n",
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("publication input variants reject mixed formats, malformed references and inexact payloads", async () => {
    const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
    const { assertPublicationAttempt } = await import("@runwield/workflow/publication");
    const { openPublication } = await import("@runwield/workflow/publication-runtime");
    const { publicationCopiesForCheckout } = await import("../../plan-store/index.ts");
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("artifact_receipt")).code, 86);
        const attempt = await openPublication(f.root).attempt(f.workflow.worktreeId!).load();
        ok(attempt?.packageInput);
        throws(() => assertPublicationAttempt({ ...attempt, deliveryMetadataVersion: 1 }), /Mixed/);
        throws(() => assertPublicationAttempt(JSON.parse(JSON.stringify({ ...attempt, packageInput: null }))));
        throws(
            () =>
                assertPublicationAttempt(
                    JSON.parse(JSON.stringify({ ...attempt, packageInput: undefined, copiesPrepared: true })),
                ),
            /Unknown/,
        );
        await rejects(
            openProjectPlanStore(f.identity.projectId, { admitted: f.identity }).publicationCopies.read({
                ...attempt.packageInput,
                digest: "0".repeat(64),
            }),
            /changed/,
        );
        await fs.writeFile(join(attempt.executionCwd, "docs/plans/one/context.md"), "# Wrong payload\n");
        await git(attempt.executionCwd, ["add", "docs/plans/one/context.md"]);
        await git(attempt.executionCwd, ["commit", "--amend", "--no-edit"]);
        equal(
            await publicationCopiesForCheckout(f.root).verifyCandidate(
                attempt,
                await git(attempt.executionCwd, ["rev-parse", "HEAD"]),
                attempt.executionCwd,
            ),
            null,
        );
    } finally {
        await f.cleanup();
    }
});

for (const scenario of ["changed", "unchanged", "externally-edited"] as const) {
    test(`successive copy-enabled deliveries preserve ${scenario} prior-copy ownership`, async () => {
        const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
        const f = await publicationFixture(true);
        const editor = `${f.root}-copy-editor`;
        try {
            const first = await f.drive();
            equal(first.code, 0, first.text);
            const firstReceipt = (await read(f.identity)).metadata.workflow!.delivery!;
            const text = scenario === "unchanged" ? "# A Plan\n\nProse — 世界\n" : "# Second reviewed Plan\n";
            await f.implementNext(text);
            ok(f.workflow.worktreeId !== firstReceipt.source.attemptId);
            equal((await f.drive("candidate_receipt")).code, 86);
            if (scenario === "externally-edited") {
                await git(f.root, ["clone", f.remote, editor]);
                await git(editor, ["config", "user.name", "Fixture"]);
                await git(editor, ["config", "user.email", "fixture@example.test"]);
                await fs.writeFile(join(editor, "docs/plans/one/context.md"), "# Someone edited the old copy\n");
                await git(editor, ["add", "docs/plans/one/context.md"]);
                await git(editor, ["commit", "-m", "edit prior delivery copy"]);
                await git(editor, ["push", "origin", "main"]);
                const target = await git(f.remote, ["rev-parse", "main"]);
                const { publicationCopiesForCheckout } = await import("../../plan-store/index.ts");
                await rejects(
                    publicationCopiesForCheckout(f.root).assertTargetDestinations(
                        editor,
                        (await read(f.identity)).metadata.workflow!.publication!,
                        "HEAD",
                    ),
                    /ownership/,
                );
                const refused = await f.drive();
                ok(refused.code !== 0, refused.text);
                equal(await git(f.remote, ["rev-parse", "main"]), target);
                equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# Someone edited the old copy");
                equal((await read(f.identity)).metadata.definition.status, "reviewed");
                await fs.writeFile(join(editor, "docs/plans/one/context.md"), "# A Plan\n\nProse — 世界\n");
                await git(editor, ["add", "docs/plans/one/context.md"]);
                await git(editor, ["commit", "-m", "restore exact prior copy"]);
                await git(editor, ["push", "origin", "main"]);
            }
            const second = await f.drive();
            equal(second.code, 0, second.text);
            equal(await git(f.remote, ["show", "main:code.txt"]), "second implementation");
            equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), text.trim());
            const history = await git(f.remote, ["log", "--format=%B", "main"]);
            equal(history.split("RunWield-Publication-Attempt:").length - 1, scenario === "unchanged" ? 1 : 2);
            const current = await read(f.identity);
            equal(current.metadata.definition.status, "verified");
            equal(current.metadata.workflow?.attempt, undefined);
            ok(current.metadata.workflow?.delivery?.source.inputId !== firstReceipt.source.inputId);
            equal(await fs.readFile(join(current.path, "context.md"), "utf8"), text);
        } finally {
            await f.cleanup();
        }
    });
}

test("retained Markdown preserves BOM and CRLF bytes in copies and Recorder source", async () => {
    const { publicationFixture } = await import("./testing/package-publication-fixture.ts");
    const { captureForegroundProcess } = await import("../captured-process.ts");
    const { loadPublishedWorkRecordSource } = await import("../../plan-store/index.ts");
    const { decodePackageMarkdown } = await import("@runwield/plans/format");
    const { assertDeliveryCopies } = await import("@runwield/plans/publication-copies");
    throws(() => decodePackageMarkdown(new Uint8Array([0xff])));
    throws(() => assertDeliveryCopies([{ kind: "work-record", path: "docs/work-records/invalid.md", text: "\ud800" }]));
    const documents = {
        "context.md": "\ufeff# Byte-exact Plan\r\n\r\nProse — 世界\r\n",
        "validation.md": "\ufeff# Exact checks\r\n",
    };
    const f = await publicationFixture(true, [], undefined, false, documents);
    try {
        const published = await f.drive();
        equal(published.code, 0, published.text);
        for (const [name, text] of Object.entries(documents)) {
            const blob = await captureForegroundProcess("git", {
                cwd: f.remote,
                args: ["show", `main:docs/plans/one/${name}`],
            });
            equal(blob.code, 0);
            deepEqual(blob.stdout, new TextEncoder().encode(text));
        }
        await f.scope(async () =>
            equal((await loadPublishedWorkRecordSource(f.root, "one"))?.body, documents["context.md"]),
        );
    } finally {
        await f.cleanup();
    }
});
