import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainTestEvidence } from "./retain-test-evidence.ts";

test("test cleanup retains Golden failure diagnostics but not sandbox HOME or caches", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const sandbox = join(root, "sandbox");
        const destination = join(root, "evidence");
        for (const path of [
            "home-slot",
            "deno-dir",
            "slot/tmp/unrelated",
            "slot/tmp/runwield-golden-tui-timeout-123",
            "slot/tmp/runwield-golden-tui-child-failure-456",
            "tmp-legacy/runwield-golden-tui-timeout-789",
            "slot/.cache/runwield-golden-tui-timeout-private",
        ]) {
            await fsMkdir(join(sandbox, path), { recursive: true });
            await fsWriteFile(join(sandbox, path, "data.json"), path);
        }
        await retainTestEvidence(sandbox, destination);
        await fsRm(sandbox, { recursive: true });
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-timeout-123/data.json"), "utf8"),
            "slot/tmp/runwield-golden-tui-timeout-123",
        );
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-child-failure-456/data.json"), "utf8"),
            "slot/tmp/runwield-golden-tui-child-failure-456",
        );
        assertEquals(
            await fsReadFile(join(destination, "runwield-golden-tui-timeout-789/data.json"), "utf8"),
            "tmp-legacy/runwield-golden-tui-timeout-789",
        );
        assertEquals(
            (
                await Array.fromAsync(await fsReaddir(destination, { withFileTypes: true }), (entry) => entry.name)
            ).sort(),
            [
                "runwield-golden-tui-child-failure-456",
                "runwield-golden-tui-timeout-123",
                "runwield-golden-tui-timeout-789",
            ],
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("artifact reports preserve failure checkpoints but omit transcripts, paths and raw errors", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const sandbox = join(root, "sandbox");
        const raw = join(root, "local-raw");
        const report = join(root, "ci-report");
        const timeout = "runwield-golden-tui-timeout-test";
        const wrapper = "runwield-golden-tui-child-failure-test";
        const temp = join(sandbox, "slot", "tmp");
        const timeoutPath = join(temp, timeout);
        const wrapperPath = join(temp, wrapper);
        const secret = "never-export-this-transcript-or-path";
        await fsMkdir(timeoutPath, { recursive: true });
        await fsMkdir(wrapperPath, { recursive: true });
        await fsWriteFile(join(timeoutPath, "startup-phase.txt"), "starting scenario\n");
        await fsWriteFile(
            join(timeoutPath, "timeout-diagnostics.json"),
            JSON.stringify({
                scenario: "load-plan-direct-review-approves-and-runs",
                currentAction: "waitForIdle",
                actionIndex: 4,
                lastPlanObservation: {
                    executionStatus: "reviewed",
                    remoteStatus: "unreadable",
                    localStatus: "ready_for_work",
                    registryStatus: "completed",
                    lookupError: "Golden publication Git show failed: " + secret,
                },
                cwd: secret,
                scrollback: secret,
                events: [
                    "terminal:type:" + secret,
                    "runtime:tool:start:transcriptsecret",
                    "concurrent:transcriptsecret:runtime:tool:result:task_completed:ok",
                    "runtime:tool:result:task_completed:ok",
                    "runtime:turn_end",
                ],
                validationErrors: JSON.stringify({
                    name: "ValidationStateError",
                    operation: "review",
                    message: secret,
                }),
                runtime: {
                    busy: true,
                    activeTurnId: null,
                    activeAgent: "plan-engineer",
                    queuedMessages: [secret],
                    workflowContext: { status: "ready_for_work", validationProgress: { stage: "cycle" } },
                },
                actor: { consumed: [secret], remaining: [] },
            }),
        );
        await fsWriteFile(
            join(wrapperPath, "child-diagnostics.json"),
            JSON.stringify({
                exportName: "loadPlanDirectReviewRunScenario",
                pid: 123,
                ready: true,
                code: 143,
                timedOut: true,
                stdout: secret,
                stderr: secret,
                childPayload: { error: "Timed out waiting for TUI composition idle: " + secret },
            }),
        );
        await retainTestEvidence(sandbox, raw, report);
        const local = await fsReadFile(join(raw, timeout, "timeout-diagnostics.json"), "utf8");
        const exposed = await fsReadFile(join(report, timeout + ".json"), "utf8");
        const child = await fsReadFile(join(report, wrapper + ".json"), "utf8");
        assertEquals(local.includes(secret), true);
        assertEquals((exposed + child).includes(secret), false);
        const observed = JSON.parse(exposed)["timeout-diagnostics.json"];
        assertEquals(observed.currentAction, "waitForIdle");
        assertEquals(observed.startupPhase, "starting scenario");
        assertEquals(observed.runtime, {
            agent: "plan-engineer",
            busy: true,
            activeTurn: false,
            queued: 1,
            planStatus: "ready_for_work",
            validationStage: "cycle",
        });
        assertEquals(exposed.includes("transcriptsecret"), false);
        assertEquals(observed.events, [
            "concurrent:runtime:tool:result:task_completed:ok",
            "runtime:tool:result:task_completed:ok",
            "runtime:turn_end",
        ]);
        assertEquals(observed.planObservation, {
            executionStatus: "reviewed",
            remoteStatus: "unreadable",
            localStatus: "ready_for_work",
            registry: "completed",
            lookupError: "Golden publication Git show failed",
        });
        assertEquals(observed.lastValidationError, { type: "ValidationStateError", operation: "review" });
        const failedChild = JSON.parse(child)["child-diagnostics.json"];
        assertEquals(failedChild.childPid, 123);
        assertEquals(failedChild.childReady, true);
        assertEquals(failedChild.childExit, 143);
        assertEquals(failedChild.timedOut, true);
        assertEquals(failedChild.error, "Timed out waiting for TUI composition idle");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("shareable-only reporting never moves a raw diagnostic out of its sandbox", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const sandbox = join(root, "sandbox");
        const report = join(root, "ci-report");
        const timeout = "runwield-golden-tui-timeout-hosted";
        const raw = join(sandbox, "slot", "tmp", timeout);
        await fsMkdir(raw, { recursive: true });
        const transcript = "raw transcript must not leave this sandbox";
        await fsWriteFile(
            join(raw, "timeout-diagnostics.json"),
            JSON.stringify({ scenario: "hosted", scrollback: transcript }),
        );
        await retainTestEvidence(sandbox, undefined, report);
        assertEquals((await fsReadFile(join(raw, "timeout-diagnostics.json"), "utf8")).includes(transcript), true);
        const exported = await fsReadFile(join(report, timeout + ".json"), "utf8");
        assertEquals(exported.includes("hosted"), true);
        assertEquals(exported.includes(transcript), false);
        assertEquals((await fsReaddir(root)).sort(), ["ci-report", "sandbox"]);
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
});
