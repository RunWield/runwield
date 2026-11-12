import { test } from "node:test";
import { ok as assert, strictEqual as equal, deepStrictEqual as same } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, create, read, tree } from "../testing/plan-package-fixture.ts";
import { withPlanAccess, selectPlanAccess } from "../../plan-store/index.ts";
import { savePlanDocument } from "../../plan-store/index.ts";
import { writeWorkRecord } from "../work-records/store.ts";
import { recordAttrs, recordBody } from "../work-records/test-fixtures/package-records.ts";
import { EVIDENCE, reachPlanning, planWrittenInput, runOperation, readRecordBytes } from "./attached-test-fixture.ts";
import type { AttachedJsonObject, AttachedReadOperationName } from "./operations.ts";

test("Connect document reads bind canonical Plan pages and Work Records to the current action", async () => {
    const f = await packageFixture();
    const other = await packageFixture();
    try {
        const prose = "# Canonical Plan\n\n世界 café 🛠\n".repeat(20);
        await create(f.identity, {
            name: "dark-mode-toggle",
            documents: { "context.md": prose, "validation.md": "# Checks\n" },
        });
        const { planning } = await reachPlanning(f.root);
        await withPlanAccess(f.root, (await selectPlanAccess(f.root, "plan-one"))!, async () => {
            const submitted = await runOperation(
                "plan_written",
                f.root,
                planWrittenInput({ ...planning, executionAgent: "engineer", collaborationRecommendation: "pair" }),
            );
            assert(submitted.ok && submitted.workflow.review);
            const envelope = {
                evidence: EVIDENCE,
                workflowId: submitted.workflow.workflowId,
                actionId: submitted.workflow.review.actionId,
            };
            const call = (name: AttachedReadOperationName, extras: AttachedJsonObject = {}) =>
                runOperation(name, f.root, { ...envelope, ...extras });
            const first = await call("read_plan", { maxBytes: 31 });
            assert(first.ok && "documentRevision" in first && first.planRevision);
            let assembled = first.content;
            let next = first;
            while (next.truncated) {
                const page = await call("read_plan", {
                    maxBytes: 31,
                    offsetBytes: next.nextOffsetBytes,
                    documentRevision: first.documentRevision,
                });
                assert(page.ok && "documentRevision" in page);
                equal(page.documentRevision, first.documentRevision);
                assembled += page.content;
                next = page;
            }
            equal(assembled, prose);
            const validation = await call("read_plan", { resource: "validation.md" });
            assert(validation.ok && "content" in validation);
            equal(validation.content, "# Checks\n");
            const record = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            const archived = await writeWorkRecord(
                f.root,
                recordAttrs({ archivedAt: "2026-11-02T00:00:00.000Z" }),
                recordBody,
            );
            const historical = await call("work_record_read", { recordId: archived.attrs.recordId });
            assert(!historical.ok);
            const found = await call("work_record_read", { recordId: record.attrs.recordId });
            assert(found.ok && "documentRevision" in found);
            assert(found.content.includes("Canonical evidence"));
            assert(found.content.includes("status: approved"));
            equal(found.accessMode, "current");
            const beforeWorkflow = await readRecordBytes(f.root, envelope.workflowId);
            const beforePackage = await tree((await read(f.identity)).path);
            for (const [name, extras] of [
                ["read_plan", { resource: "../../private.md" }],
                ["read_plan", { path: join((await read(f.identity)).path, "context.md") }],
                ["read_plan", { actionId: "stale-action" }],
                ["read_plan", { offsetBytes: 4 }],
                ["work_record_read", { recordId: "../../private" }],
                ["work_record_read", { recordId: "not-found" }],
                ["work_record_read", { recordId: archived.attrs.recordId, accessMode: "all" }],
                ["work_record_search", { query: "evidence", actionId: "stale-action" }],
            ] as const) {
                const rejected = await call(name, extras);
                assert(!rejected.ok, JSON.stringify(rejected));
                equal("content" in rejected, false);
            }
            const unrelated = await runOperation("read_plan", other.root, envelope);
            assert(!unrelated.ok);
            same(await tree((await read(f.identity)).path), beforePackage);
            equal(await readRecordBytes(f.root, envelope.workflowId), beforeWorkflow);
            await savePlanDocument("plan-one", "context.md", first.planRevision, "# Newer content\n");
            const stale = await call("read_plan", {
                offsetBytes: first.nextOffsetBytes,
                documentRevision: first.documentRevision,
            });
            assert(!stale.ok);
            equal(stale.rejection.code, "revision_conflict");
            const fresh = await call("read_plan");
            assert(fresh.ok && "content" in fresh);
            equal(fresh.content, "# Newer content\n");
            const recordPage = await call("work_record_read", { recordId: record.attrs.recordId, maxBytes: 20 });
            assert(recordPage.ok && "documentRevision" in recordPage);
            await writeFile(record.path, record.markdown.replace("Canonical evidence", "Updated evidence"));
            const changed = await call("work_record_read", {
                recordId: record.attrs.recordId,
                offsetBytes: recordPage.nextOffsetBytes,
                documentRevision: recordPage.documentRevision,
            });
            assert(!changed.ok);
            equal(changed.rejection.code, "revision_conflict");
        });
    } finally {
        await f.cleanup();
        await other.cleanup();
    }
});

test("a restricted external host reads home documents through the actual MCP carrier without direct home access", async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { mkdir, realpath } = await import("node:fs/promises");
    const f = await packageFixture();
    const other = await packageFixture();
    try {
        const p = await create(f.identity, {
            name: "dark-mode-toggle",
            documents: { "context.md": "# Canonical home Plan\n", "validation.md": "# Checks\n" },
        });
        const { planning } = await reachPlanning(f.root);
        const fixturePath = fileURLToPath(new URL("./document-host-fixture.ts", import.meta.url));
        await create(other.identity);
        const foreign = await withPlanAccess(
            other.root,
            (await selectPlanAccess(other.root, "plan-one"))!,
            async () => {
                return await writeWorkRecord(other.root, recordAttrs(), recordBody);
            },
        );
        await withPlanAccess(f.root, (await selectPlanAccess(f.root, "plan-one"))!, async () => {
            const submitted = await runOperation(
                "plan_written",
                f.root,
                planWrittenInput({ ...planning, executionAgent: "engineer", collaborationRecommendation: "pair" }),
            );
            assert(submitted.ok && submitted.workflow.review);
            const record = await writeWorkRecord(f.root, recordAttrs(), recordBody);
            const archived = await writeWorkRecord(
                f.root,
                recordAttrs({ archivedAt: "2026-11-02T00:00:00.000Z" }),
                recordBody,
            );
            const bin = join(f.root, "test-bin");
            await mkdir(bin);
            // Mnemoteca is an external process; Core still performs real canonical hydration and status filtering.
            const candidates = [record.attrs.recordId, archived.attrs.recordId, foreign.attrs.recordId].map((id) => ({
                metadata: { tags: [`work-record:${id}`] },
            }));
            await writeFile(
                join(bin, "mnemoteca"),
                `#!/bin/sh\ncase "$1" in\nlist) echo '[1] indexed' ;;\nsearch) cat <<'RESULT'\n${JSON.stringify({ results: candidates })}\nRESULT\n;;\n*) exit 1 ;;\nesac\n`,
                { mode: 0o755 },
            );
            const config = {
                root: f.root,
                workflowId: submitted.workflow.workflowId,
                actionId: submitted.workflow.review.actionId,
                planPath: join(p.path, "context.md"),
                recordPath: record.path,
                recordId: record.attrs.recordId,
                archivedId: archived.attrs.recordId,
                foreignId: foreign.attrs.recordId,
                restrict: process.platform === "darwin",
            };
            const before = await tree(p.path);
            const recordBefore = await tree(join(record.path, ".."));
            const workflowBefore = await readRecordBytes(f.root, config.workflowId);
            for (let reconnect = 0; reconnect < 2; reconnect++) {
                const args = [fixturePath, "host", JSON.stringify(config)];
                const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(await realpath(join(f.identity.executionAccountHome, ".wld", "projects")))}))`;
                const core = spawn(process.execPath, [fixturePath, "core", JSON.stringify(config)], {
                    cwd: f.root,
                    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                const host = config.restrict
                    ? spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, ...args], {
                          stdio: ["pipe", "pipe", "pipe"],
                      })
                    : spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
                let diagnostics = "";
                core.stderr.on("data", (data) => {
                    diagnostics += String(data);
                });
                host.stderr.on("data", (data) => {
                    diagnostics += String(data);
                });
                core.stdout.pipe(host.stdin);
                host.stdout.pipe(core.stdin);
                const timer = setTimeout(() => {
                    host.kill();
                    core.kill();
                }, 30000);
                try {
                    const code = await new Promise<number | null>((resolve) => host.once("exit", resolve));
                    equal(code, 0, diagnostics);
                    assert(diagnostics.includes("DOCUMENT_HOST_OK"), diagnostics);
                } finally {
                    clearTimeout(timer);
                    host.kill();
                    core.kill();
                }
            }
            same(await tree(p.path), before);
            same(await tree(join(record.path, "..")), recordBefore);
            equal(await readRecordBytes(f.root, config.workflowId), workflowBefore);
        });
    } finally {
        await f.cleanup();
        await other.cleanup();
    }
});

test("Recorder document reads retain all-status Work Record access without advancing delivery", async () => {
    const { attachedValidationFixture } = await import("./validation-test-fixture.ts");
    const { approveSemantic } = await import("./delivery-test-fixture.ts");
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok);
        const ready = await approveSemantic(fixture, started.workflow);
        assert(ready.ok && ready.workflow.nextAction.kind === "recorder");
        const archived = await writeWorkRecord(
            fixture.root,
            recordAttrs({ archivedAt: "2026-11-02T00:00:00.000Z" }),
            recordBody,
        );
        const before = await readRecordBytes(fixture.root, fixture.workflowId);
        const result = await runOperation("work_record_read", fixture.root, {
            evidence: EVIDENCE,
            workflowId: fixture.workflowId,
            actionId: ready.workflow.nextAction.actionId,
            recordId: archived.attrs.recordId,
        });
        assert(result.ok && "documentRevision" in result, JSON.stringify(result));
        equal(result.accessMode, "all");
        assert(result.content.includes("Canonical evidence"));
        assert(result.content.toLowerCase().includes("archived"));
        equal(await readRecordBytes(fixture.root, fixture.workflowId), before);
    } finally {
        await fixture.close();
    }
});
