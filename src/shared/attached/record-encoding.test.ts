import { test } from "node:test";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAttachedRecord, readAttachedRecord, readAttachedRecordHeader } from "./record-encoding.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, scrubAttachedChat } from "./record-store.ts";

test("review reads retain exact replays and coverage without duplicating the whole candidate per page", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        await writeFile(join(fixture.cwd, "large.txt"), "A reviewed Unicode line: café 🧭\n".repeat(8000));
        const started = await fixture.call("start_validation", await fixture.status());
        ok(started.ok && started.workflow.nextAction.kind === "validation");
        const action = started.workflow.nextAction;
        ok(action.request.kind === "reviewer");
        const diffBytes = Buffer.byteLength(action.request.fullDiff);
        ok(diffBytes > 200_000);
        const payload = { actionId: action.actionId, command: "show", scope: "full", path: "large.txt", maxBytes: 512 };
        const first = await fixture.call("review_diff", started.workflow, payload, "constructor");
        ok(first.ok && first.diff?.coverage);
        let workflow = first.workflow;
        for (let index = 0; index < 24; index++) {
            const result = await fixture.call("review_diff", workflow, { ...payload, offsetBytes: 512 * (index + 1) });
            ok(result.ok);
            workflow = result.workflow;
        }
        deepStrictEqual(await fixture.call("review_diff", started.workflow, payload, "constructor"), first);
        const location = locateAttachedWorkflows(fixture.root);
        const path = join(location.workflowsDir, `${fixture.workflowId}.json`);
        const compactBytes = (await stat(path)).size;
        ok(compactBytes < diffBytes * 3, `${compactBytes} bytes for ${diffBytes} bytes of candidate`);
        const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        ok(loaded.status === "found");
        equal(loaded.record.validation?.coverage.length, 25);
        const { instructions: _instructions, compatibility: _compatibility, ...durableFirst } = first;
        ok(Object.hasOwn(loaded.record.acceptedOperations, "constructor"));
        deepStrictEqual(loaded.record.acceptedOperations["constructor"].result, durableFirst);

        // Existing installations already have the expanded schema. Reading must be passive;
        // the next real guarded operation performs the migration without resetting the review.
        await writeFile(path, JSON.stringify(loaded.record));
        const legacyBytes = (await stat(path)).size;
        ok(legacyBytes > compactBytes * 8);
        const restored = await loadAttachedWorkflowRecord(location, fixture.workflowId);
        ok(restored.status === "found");
        deepStrictEqual(restored.record, loaded.record);
        equal((await stat(path)).size, legacyBytes);
        const next = await fixture.call("review_diff", workflow, { ...payload, offsetBytes: 13_000 });
        ok(next.ok);
        equal(next.workflow.revision, workflow.revision + 1);
        ok((await stat(path)).size < diffBytes * 3);
        deepStrictEqual(await fixture.call("review_diff", started.workflow, payload, "constructor"), first);
    } finally {
        await fixture.close();
    }
});

test("record encoding refuses altered or missing request evidence and preserves source values", async () => {
    const fixture = await attachedValidationFixture();
    const directory = await mkdtemp(join(tmpdir(), "attached-record-encoding-"));
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        ok(started.ok);
        const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(fixture.root), fixture.workflowId);
        ok(loaded.status === "found");
        const before = JSON.stringify(loaded.record);
        const encoded = encodeAttachedRecord(scrubAttachedChat(loaded.record));
        equal(JSON.stringify(loaded.record), before);
        ok(encoded.schemaVersion === 2);
        const path = join(directory, "record.json");
        await writeFile(path, JSON.stringify(encoded));
        deepStrictEqual(readAttachedRecord(path), loaded.record);
        deepStrictEqual(readAttachedRecordHeader(path), { schemaVersion: 2, projectRoot: fixture.root });
        const id = Object.keys(encoded.validationRequests)[0];
        const request = encoded.validationRequests[id];
        ok(request.kind === "reviewer");
        request.fullDiff += "tampered";
        await writeFile(path, JSON.stringify(encoded));
        throws(() => readAttachedRecord(path), /request has changed/);
        delete encoded.validationRequests[id];
        await writeFile(path, JSON.stringify(encoded));
        throws(() => readAttachedRecord(path), /request is missing/);
        await writeFile(path, '{"schemaVersion":1,"projectRoot":"/valid", "broken":');
        throws(() => readAttachedRecordHeader(path), SyntaxError);
        await writeFile(path, '{"schemaVersion":99}');
        throws(() => readAttachedRecord(path), /Unsupported Attached record schema/);
        equal(await readFile(path, "utf8"), '{"schemaVersion":99}');
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});
