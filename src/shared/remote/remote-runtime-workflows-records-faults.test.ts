import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.js";
import type { RemoteSessionRequest } from "./session-protocol.ts";
import {
    assertRemoteStorageAbsent,
    withRemoteRuntimeFixture,
    type RuntimeFixture,
} from "./remote-runtime-test-fixture.ts";

async function request(f: RuntimeFixture, input: RemoteSessionRequest) {
    return await fetch(`http://127.0.0.1:${f.connection.port}/session/request`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.connection.credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

const recordKinds = ["records", "artifact", "plan-association", "plan-review"] as const;

test("remote record receipts support identical retries and refuse conflicting, out-of-order and settled identities", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await savePlan(f.remoteProject, "record-retries", "# Record retries\n", {
            planId: "retry-plan",
            classification: "QUICK_FIX",
            status: "draft",
        });
        let turns = 0;
        f.setModelResponseFactory(() =>
            ++turns === 1
                ? fauxAssistantMessage(fauxToolCall("plan_written", { planName: "record-retries" }))
                : fauxAssistantMessage(fauxText("Saved.")),
        );
        const tested = new Set<string>();
        const receipts: RemoteSessionRequest[] = [];
        f.policy.handle = async (input, path, response) => {
            if (
                path !== "/session/request" ||
                !recordKinds.includes(input.kind as (typeof recordKinds)[number]) ||
                tested.has(input.kind) ||
                !response.ok
            )
                return response;
            tested.add(input.kind);
            const save = input as RemoteSessionRequest;
            receipts.push(save);
            const original = await response.clone().text();
            const retry = await request(f, save);
            assertEquals(retry.status, 200);
            assertEquals(await retry.text(), original, "An identical request returns the exact saved receipt");
            const conflict = await request(f, { ...save, kind: "segment", contents: "" });
            assertEquals(conflict.status, 409);
            await conflict.text();
            const future = await request(f, { ...save, kind: "records", sequence: save.sequence + 2, contents: "" });
            assertEquals(future.status, 409);
            await future.text();
            return response;
        };
        const client = await f.start();
        await client.read();
        await client.send({ kind: "plan-written" });
        const result = await client.read();
        assertEquals(result.ok, true, result.error);
        assertEquals([...tested].sort(), [...recordKinds].sort());
        assert(result.savedId);
        assertEquals(f.store.listSessionArtifacts(result.savedId).length, 1);
        assertEquals(f.store.listSessionPlanAssociations(result.savedId).length, 1);
        for (const save of receipts) {
            const stale = await request(f, save);
            assertEquals(stale.status, 409);
            await stale.text();
        }
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});

for (const kind of recordKinds) {
    test(`a lost remote ${kind} receipt faults the manager, stops later saves and reconnect does not replay work`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            await savePlan(f.remoteProject, "record-fault", "# Record fault\n", {
                planId: "fault-plan",
                classification: "QUICK_FIX",
                status: "draft",
            });
            let turns = 0;
            f.setModelResponseFactory(() =>
                ++turns === 1
                    ? fauxAssistantMessage(fauxToolCall("plan_written", { planName: "record-fault" }))
                    : fauxAssistantMessage(fauxText("Do not replay.")),
            );
            let failed: RemoteSessionRequest | null = null;
            const faultPolicy: NonNullable<RuntimeFixture["policy"]["handle"]> = async (input, path, response) => {
                if (path === "/session/request" && input.kind === kind && response.ok && !failed) {
                    failed = input as RemoteSessionRequest;
                    return new Response("lost-record-receipt", { status: 503 });
                }
                return response;
            };
            const client = await f.start();
            await client.read();
            if (kind === "records") {
                f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Saved before read fault.")));
                await client.send({ kind: "turn", text: "Create recoverable history." });
                assertEquals((await client.read()).ok, true);
            }
            f.policy.handle = faultPolicy;
            await client.send({ kind: "plan-written" });
            const result = await client.read();
            assertEquals(result.ok, false);
            assert(failed);
            const fault: RemoteSessionRequest = failed;
            assertEquals(
                f.saves.slice(f.saves.indexOf(fault) + 1).filter((save) => save.operation === fault.operation).length,
                0,
                "A caught record failure must not permit another save or workflow effect",
            );
            const created = f.controls.find((control) => control.request.kind === "create")!.request;
            assert(created.kind === "create");
            const id = created.sessionId;
            assertEquals(f.store.inspectSessionActivation(id).activation?.state, "uncertain");
            const count = f.modelRequests.length;
            await client.close();
            f.policy.handle = undefined;
            const resumed = await f.start();
            await resumed.read();
            await resumed.send({ kind: "load", sessionId: id });
            const loaded = await resumed.read();
            assertEquals(loaded.ok, true, loaded.error);
            assertEquals(f.modelRequests.length, count);
            assertEquals(
                f.store.listSessionArtifacts(id).length,
                kind === "records" || kind === "plan-association" ? 0 : 1,
            );
            assertEquals(f.store.getLastPlanReview(id)?.planId || null, kind === "plan-review" ? "fault-plan" : null);
            await resumed.close();
            await assertRemoteStorageAbsent(f);
        });
    });
}

test("an invalid laptop record operation stays faulted and cannot be repaired by a later read", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactory(() => fauxAssistantMessage(fauxText("Must not start.")));
        let poisoned = false;
        let invalidStatus = 0;
        let readStatus = 0;
        let sameError = false;
        f.policy.handle = async (input, path, response) => {
            if (path === "/session/request" && input.kind === "records" && response.ok && !poisoned) {
                poisoned = true;
                const save = input as RemoteSessionRequest;
                const invalid = await request(f, {
                    ...save,
                    kind: "artifact",
                    sequence: save.sequence + 1,
                    contents: JSON.stringify({
                        kind: "report",
                        path: "docs/no.md",
                        title: 42,
                        registeredBy: "remote-runtime",
                    }),
                });
                invalidStatus = invalid.status;
                const error = await invalid.text();
                const read = await request(f, { ...save, kind: "records", sequence: save.sequence + 1, contents: "" });
                readStatus = read.status;
                sameError = (await read.text()) === error;
            }
            return response;
        };
        const client = await f.start();
        await client.read();
        await client.send({ kind: "turn", text: "No effect after record failure." });
        const result = await client.read();
        assertEquals(result.ok, false);
        assertEquals(poisoned, true);
        assertEquals(invalidStatus, 409);
        assertEquals(readStatus, 409);
        assertEquals(sameError, true);
        assertEquals(f.modelRequests.length, 0);
        await client.close();
        await assertRemoteStorageAbsent(f);
    });
});
