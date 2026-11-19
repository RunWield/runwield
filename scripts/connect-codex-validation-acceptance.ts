import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AcceptanceWorld } from "../src/attached/codex/acceptance/world.ts";
import { field, type JsonMap } from "../src/attached/codex/acceptance/evidence.ts";
import { ReviewPage } from "../src/attached/claude/acceptance/review.ts";

/** Native installed-plugin qualification. No workflow writers or synthesized receipts. */
const root = await mkdtemp(join(tmpdir(), "runwield-native-validation-"));
const cliArgs = process.argv.slice(2);
assert(
    cliArgs.length === 0 || (cliArgs.length === 2 && cliArgs[0] === "--core"),
    "Usage: [--core <compiled executable>]",
);
const compiledCore = cliArgs[1] ? resolve(cliArgs[1]) : undefined;
const world = new AcceptanceWorld({ root, checkout: fileURLToPath(new URL("../", import.meta.url)), codex: "codex" });
const checks: string[] = [];
interface OperationTiming {
    operation: string;
    elapsedMs: number;
}
const timings: OperationTiming[] = [];
const responses: JsonMap[] = [];
let stage = "setup";
const check = (name: string, condition: boolean) => {
    assert(condition, name);
    checks.push(name);
};
const kind = (body: JsonMap) => field(body, "workflow", "nextAction", "kind");
const action = (body: JsonMap) => field(body, "workflow", "nextAction", "actionId");
const envelope = (body: JsonMap, payload: JsonMap = {}, operationId = randomUUID()): JsonMap => ({
    workflowId: field(body, "workflow", "workflowId"),
    expectedRevision: field(body, "workflow", "revision"),
    operationId,
    payload,
});
const count = async (name: string) =>
    (await readFile(join(root, "markers", name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
async function waitCount(name: string, expected: number) {
    const deadline = Date.now() + 60_000;
    while ((await count(name)) < expected) {
        assert(Date.now() < deadline, `Timeout at ${stage}: ${name} ${expected}`);
        await delay(25);
    }
}
async function digest(path: string): Promise<string> {
    const hash = createHash("sha256");
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        hash.update(entry.name);
        hash.update(
            entry.isDirectory() ? await digest(join(path, entry.name)) : await readFile(join(path, entry.name)),
        );
    }
    return hash.digest("hex");
}
await world.create();
try {
    let coreSha256: string | undefined;
    if (compiledCore) {
        const executable = join(root, "core");
        await copyFile(compiledCore, executable);
        coreSha256 = createHash("sha256")
            .update(await readFile(executable))
            .digest("hex");
        await writeFile(
            join(root, "bin/wld"),
            `#!${process.execPath}
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), {
    env: { ...${JSON.stringify(world.coreEnv)}, ...(process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT ? { RUNWIELD_ATTACHED_PLUGIN_ROOT: process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT } : {}) },
    stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("close", code => process.exit(code ?? 1));
`,
        );
    }
    const metadata = await world.prepare();
    world.install();
    let host = world.protocolHost("validation");
    await host.initialize();
    await host.inventory();
    const observer = world.protocolHost("inspection");
    await observer.initialize();
    await observer.inventory();
    const call = async (operation: string, args: JsonMap) => {
        const start = performance.now();
        const body = await host.call(operation, args, 120_000);
        timings.push({ operation, elapsedMs: performance.now() - start });
        responses.push(body);
        return body;
    };
    stage = "planning";
    let state = await call("activate", {
        operationId: randomUUID(),
        payload: {
            hostRequestId: randomUUID(),
            requestText:
                "Implement a fixture value to qualify native validation. Full CI is mandatory; stop at the reviewer handoff without publication.",
        },
    });
    state = await call(
        "triage_report",
        envelope(state, {
            actionId: action(state),
            outcome: {
                routingIntent: "PLANNED_CHANGE",
                workKind: "FEATURE",
                complexity: "LOW",
                summary: "Implement the fixture value.",
            },
        }),
    );
    state = await call("start_planning", envelope(state, { actionId: action(state) }));
    check("native-planning-prepared", state.ok === true && kind(state) === "plan");
    await mkdir(join(world.fixture, "docs/plans"), { recursive: true });
    await writeFile(
        join(world.fixture, "docs/plans/validation-fixture.md"),
        "# Validation fixture\n\n## Objective\n\nImplement a value module.\n\n## Implementation\n\nAdd value.ts exporting a numeric value.\n\n## Verification\n\nRun sh ./check.sh through Core after each repair. The controlled command exercises distinct failures and interruption. Do not publish during this qualification.\n",
    );
    state = await call("plan_written", envelope(state, { actionId: action(state), planName: "validation-fixture" }));
    check("native-plan-review", state.ok === true && kind(state) === "review");
    await new ReviewPage(root, state).approve("plan-approved");
    state = await call("status", { workflowId: field(state, "workflow", "workflowId") });
    state = await call("start_execution", envelope(state));
    check("native-execution", state.ok === true && kind(state) === "implementation");
    const cwd = field(state, "workflow", "nextAction", "executionCwd");
    assert(typeof cwd === "string");
    await writeFile(join(cwd, "value.ts"), "export const value = 1;\n");
    // External CI boundary: files outside the checkout control the subprocess only.
    await writeFile(
        join(cwd, "check.sh"),
        `#!/bin/sh
set -eu
printf '%s\n' "$$" >> "$ACCEPTANCE_MARKER_DIR/ci-runs"
run=$(wc -l < "$ACCEPTANCE_MARKER_DIR/ci-runs" | tr -d ' ')
while [ ! -f "$ACCEPTANCE_MARKER_DIR/release-$run" ]; do sleep 0.05; done
printf '%s\n' "$run" >> "$ACCEPTANCE_MARKER_DIR/ci-finished"
if [ -f "$ACCEPTANCE_MARKER_DIR/pass" ]; then exit 0; fi
printf 'FAILURE-RUN-%s\n' "$run"
exit 1
`,
    );
    state = await call(
        "task_completed",
        envelope(state, {
            actionId: action(state),
            message: "- Added the fixture value and controlled verification command. Full CI pending.",
        }),
    );
    check("native-implemented", state.ok === true && kind(state) === "implemented");
    const workflowId = field(state, "workflow", "workflowId");
    const inspect = () => observer.call("status", { workflowId, inspectOnly: true });
    for (let run = 1; run <= 4; run++) {
        stage = `CI failure ${run}`;
        const operation = run === 1 ? "start_validation" : "task_completed";
        if (run > 1) await writeFile(join(cwd, "value.ts"), `export const value = ${run};\n`);
        const args = envelope(
            state,
            run === 1
                ? {}
                : {
                      actionId: action(state),
                      message: `- Revised fixture value for failure ${run - 1}; full CI pending.`,
                  },
        );
        const running = call(operation, args);
        await waitCount("ci-runs", run);
        const before = await digest(join(root, "runwield-home/.wld/attached"));
        const inspected = await inspect();
        check(
            `run-${run}-active`,
            kind(inspected) === "validation_running" &&
                field(inspected, "workflow", "nextAction", "operationId") === args.operationId,
        );
        check(`run-${run}-read-only`, before === (await digest(join(root, "runwield-home/.wld/attached"))));
        const busy = await observer.call("start_validation", envelope(inspected));
        check(`run-${run}-duplicate-blocked`, field(busy, "rejection", "code") === "workflow_busy");
        await writeFile(join(root, "markers", `release-${run}`), "release");
        state = await running;
        check(`run-${run}-accepted`, state.ok === true);
        const replay = await call(operation, args);
        check(
            `run-${run}-replay`,
            JSON.stringify(replay) === JSON.stringify(state) && (await count("ci-runs")) === run,
        );
        const stale = await call("start_validation", envelope(inspected));
        check(`run-${run}-stale-revision`, field(stale, "rejection", "code") === "revision_conflict");
    }
    stage = "follow-up";
    const decision = await call("get_instructions", { workflowId, actionId: action(state) });
    check("native-exhaustion", JSON.stringify(decision).includes("engineer_follow_up"));
    const oldAction = action(state);
    state = await call(
        "validation_decision",
        envelope(state, { actionId: action(state), answer: { outcome: "selected", value: "engineer_follow_up" } }),
    );
    const stale = await call(
        "validation_decision",
        envelope(state, { actionId: oldAction, answer: { outcome: "selected", value: "retry" } }),
    );
    check("native-stale-action", field(stale, "rejection", "code") === "action_superseded");
    state = await call(
        "validation_decision",
        envelope(state, {
            actionId: action(state),
            answer: { outcome: "text", value: "Investigate publication timing and review reopen timeout." },
        }),
    );
    const packet = await call("get_artifact", {
        workflowId,
        actionId: action(state),
        artifact: "prompt",
        maxBytes: 65536,
    });
    const packetText = JSON.stringify(packet);
    check(
        "native-latest-failure-and-user-text",
        packetText.includes("FAILURE-RUN-4") &&
            packetText.includes("Investigate publication timing and review reopen timeout.") &&
            !packetText.includes("FAILURE-RUN-3"),
    );
    check("native-ci-candidate-binding", packetText.includes("Candidate:") && packetText.includes("Run ID:"));
    check("follow-up-does-not-rerun-CI", (await count("ci-runs")) === 4);
    stage = "interruption";
    await writeFile(join(cwd, "value.ts"), "export const value = 5;\n");
    const interruptedArgs = envelope(state, {
        actionId: action(state),
        message: "- Revised the fixture value after follow-up; full CI pending.",
    });
    const interrupted = call("task_completed", interruptedArgs).catch(() => null);
    await waitCount("ci-runs", 5);
    const pids = (await readFile(join(root, "markers/ci-runs"), "utf8")).trim().split("\n");
    const pid = Number(pids.at(-1));
    await host.stop();
    await interrupted;
    const deadline = Date.now() + 10_000;
    let gone = false;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            gone = true;
            break;
        }
        await delay(25);
    }
    check("native-interruption-stops-CI", gone);
    state = await inspect();
    check("native-interruption-recovery", kind(state) === "validation_recovery");
    host = world.protocolHost("recovered");
    await host.initialize();
    await host.inventory();
    await writeFile(join(root, "markers/pass"), "pass");
    await writeFile(join(root, "markers/release-6"), "release");
    const recoveryArgs = envelope(state);
    state = await call("start_validation", recoveryArgs);
    check(
        "native-recovered-reviewer",
        state.ok === true && field(state, "workflow", "nextAction", "request", "kind") === "reviewer",
    );
    check("native-one-replacement-CI", (await count("ci-runs")) === 6 && (await count("ci-finished")) === 5);
    const beforeReplay = await digest(join(root, "runwield-home/.wld/attached"));
    const replay = await call("task_completed", interruptedArgs);
    check(
        "native-original-receipt-replay",
        replay.ok === true && field(replay, "workflow", "revision") === field(state, "workflow", "revision"),
    );
    check(
        "native-replay-no-effects",
        (await count("ci-runs")) === 6 && beforeReplay === (await digest(join(root, "runwield-home/.wld/attached"))),
    );
    await writeFile(
        join(root, "summary.json"),
        JSON.stringify(
            {
                outcome: "pass",
                scope: "installed-native-MCP-validation",
                coreExecutable: compiledCore ?? "source",
                coreSha256,
                ...metadata,
                checks,
                timings,
                limitations: [
                    "Protocol qualification, no model dispatch or publication claim. CI is a real controlled subprocess in a disposable repository.",
                ],
            },
            null,
            2,
        ),
    );
} catch (error) {
    await writeFile(
        join(root, "summary.json"),
        JSON.stringify({ outcome: "fail", stage, error: String(error), checks, timings }, null, 2),
    );
    process.exitCode = 1;
} finally {
    await world.close();
    await writeFile(join(root, "responses.json"), JSON.stringify(responses, null, 2));
    console.log(`Native validation evidence: ${root}/summary.json`);
}
