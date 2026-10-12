import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import lockfile from "proper-lockfile";
import { setCustomSetting } from "../settings.js";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { getWorkflowMetricsFilePath, recordWorkflowMetric } from "./metrics.js";
import { appendWorkflowMetric, clearWorkflowMetricJournal, resolveCollectionEpoch } from "./metrics-journal.ts";

const metric = { v: 2, category: "command", event: "command_started", recorderId: "test", seq: 0, command: "help" };

/** @param {string} path */
async function readJournal(path) {
    return (await Deno.readTextFile(path)).trim().split("\n").map((line) => JSON.parse(line));
}

/** @param {string} path @param {boolean} [enabled] */
function invocation(path, enabled = true) {
    return { enabled, epoch: resolveCollectionEpoch(path, enabled).collectionEpoch.id, deadline: Date.now() + 1000 };
}

Deno.test("journal preserves opt-in and project-over-global precedence", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await Deno.remove(join(projectRoot, ".wld", "settings.json"));
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, false);
        await setCustomSetting("workflowMetrics", false, "global", projectRoot);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, false);
        await setCustomSetting("workflowMetrics", { enabled: true }, "project", projectRoot);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, true);
        await setCustomSetting("workflowMetrics", true, "global", projectRoot);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, false);
        assertEquals((await readMetrics()).length, 1);
    });
});

Deno.test("journal excludes invocations across disable and re-enable without replay", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        const startedEnabled = invocation(path);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        const rejected = await appendWorkflowMetric(path, projectRoot, { ...metric, eventId: "old" }, startedEnabled);
        assertEquals(rejected.persisted, false);
        assertEquals(rejected.reason, "disabled");
        const startedDisabled = invocation(path, false);
        await recordWorkflowMetric(metric, projectRoot);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        assertEquals((await appendWorkflowMetric(path, projectRoot, metric, startedDisabled)).persisted, false);
        const stale = await appendWorkflowMetric(path, projectRoot, metric, startedEnabled);
        assertEquals(stale.reason, "collection_boundary");
        await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        assertEquals((await readMetrics()).length, 2);
        assertEquals(
            (await readJournal(path)).filter((row) => row.event === "collection_epoch").map((row) => row.enabled),
            [true, false, true],
        );
    });
});

Deno.test("upgrade keeps v1 bytes and unknown history without transcript replay", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await Deno.mkdir(dirname(path), { recursive: true });
        const old = '{"v":1,"event":"old","details":{"safe":true}}\n';
        await Deno.writeTextFile(path, old);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        await Deno.writeTextFile(join(projectRoot, "transcript.jsonl"), '{"text":"private activity"}\n');
        await recordWorkflowMetric(metric, projectRoot);
        assertEquals(await Deno.readTextFile(path), old);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        assert((await Deno.readTextFile(path)).startsWith(old));
        const rows = await readJournal(path);
        assertEquals(rows.length, 3);
        assertEquals(rows[1].event, "collection_epoch");
        assertEquals(JSON.stringify(rows).includes("private activity"), false);
        await Deno.writeTextFile(
            join(dirname(path), "state.json"),
            JSON.stringify({
                v: 1,
                collectionEpoch: { id: "stale", enabled: true },
                historyEpoch: "stale",
            }),
        );
        await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        const state = JSON.parse(await Deno.readTextFile(join(dirname(path), "state.json")));
        assertEquals(state.collectionEpoch.id, rows[1].collectionEpoch);
    });
});

Deno.test("contended journal skips within its budget and retry keeps observation identity", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        const script = join(projectRoot, "lock-holder.js");
        await Deno.writeTextFile(
            script,
            `import lockfile from "proper-lockfile";
const release = lockfile.lockSync(Deno.args[0], {realpath:false});
console.log("ready"); await Deno.stdin.read(new Uint8Array(1)); release();`,
        );
        const holder = new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "-A",
                "--config",
                new URL("../../../deno.json", import.meta.url).pathname,
                script,
                join(dirname(path), ".journal.lock"),
            ],
            stdin: "piped",
            stdout: "piped",
        }).spawn();
        const reader = holder.stdout.getReader();
        await reader.read();
        let failed;
        const start = Date.now();
        try {
            failed = await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
            assertEquals(failed.persisted, false);
            assertEquals(failed.reason, "lock_timeout");
            assert(Date.now() - start < 1400);
        } finally {
            const writer = holder.stdin.getWriter();
            await writer.write(new Uint8Array([10]));
            await writer.close();
            writer.releaseLock();
            assertEquals((await holder.status).code, 0);
            await reader.cancel();
            reader.releaseLock();
        }
        const saved = await recordWorkflowMetric(failed, projectRoot);
        assertEquals(saved.persisted, true);
        assertEquals(saved.eventId, failed.eventId);
        assertEquals((await readJournal(path)).filter((row) => row.eventId === saved.eventId).length, 1);
    });
});

Deno.test("two processes preserve complete unique saved observations and report budget skips", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const script = join(projectRoot, "writer.js");
        const module = new URL("./metrics.js", import.meta.url).href;
        await Deno.writeTextFile(
            script,
            `import { recordWorkflowMetric } from ${JSON.stringify(module)};
const results = [];
for (let seq = 0; seq < 12; seq++) {
results.push(await recordWorkflowMetric({ v:2, category:"command", event:"command_started", recorderId:Deno.args[1], seq, command:"help" }, Deno.args[0]));
}
console.log(JSON.stringify(results));`,
        );
        const results = await Promise.all(
            ["one", "two"].map((id) =>
                new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        "--config",
                        new URL("../../../deno.json", import.meta.url).pathname,
                        script,
                        projectRoot,
                        id,
                    ],
                    env: { HOME: homeDir },
                    stdout: "piped",
                    stderr: "piped",
                }).output()
            ),
        );
        const outcomes = results.flatMap((result, index) => {
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            const reported = JSON.parse(new TextDecoder().decode(result.stdout));
            assertEquals(reported.length, 12);
            for (const [seq, outcome] of reported.entries()) {
                assertEquals(outcome.recorderId, index === 0 ? "one" : "two");
                assertEquals(outcome.seq, seq);
                assertEquals(typeof outcome.persisted, "boolean");
                assertEquals(typeof outcome.eventId, "string");
                if (!outcome.persisted) assertEquals(outcome.reason, "lock_timeout");
            }
            return reported;
        });
        assertEquals(new Set(outcomes.map((outcome) => outcome.eventId)).size, 24);
        const saved = outcomes.filter((outcome) => outcome.persisted).map(({ persisted: _persisted, ...record }) =>
            record
        );
        assert(saved.length > 0);
        const observations = (await readJournal(getWorkflowMetricsFilePath(projectRoot))).filter((row) => row.v === 2);
        assertEquals(observations.length, saved.length);
        for (const record of saved) assertEquals(observations.find((row) => row.eventId === record.eventId), record);
    });
});

Deno.test("kill and restart repairs incomplete final evidence without losing earlier records", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const first = await recordWorkflowMetric(metric, projectRoot);
        const script = join(projectRoot, "torn.js");
        await Deno.writeTextFile(
            script,
            `const file = Deno.openSync(Deno.args[0], {write:true, append:true});
file.writeSync(new TextEncoder().encode('{"v":2,"eventId":"incomplete'));
file.syncSync(); console.log("ready"); await new Promise(() => {});`,
        );
        const child = new Deno.Command(Deno.execPath(), { args: ["run", "-A", script, path], stdout: "piped" }).spawn();
        const reader = child.stdout.getReader();
        await reader.read();
        child.kill("SIGKILL");
        await child.status;
        await reader.cancel();
        reader.releaseLock();
        const next = await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        assertEquals(next.persisted, true);
        const rows = await readJournal(path);
        assertEquals(rows.filter((row) => row.eventId === first.eventId).length, 1);
        assertEquals(rows.filter((row) => row.event === "measurement_gap")[0].reason, "incomplete_append");
        assertEquals(rows.filter((row) => row.v === 2).length, 2);
    });
});

Deno.test("interior corruption stays isolated with an explicit coverage gap", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        await Deno.writeTextFile(path, 'broken-interior\n{"v":1,"event":"legacy"}\n', { append: true });
        const result = await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        assertEquals(result.persisted, true);
        assert(result.coverageGap);
        assertEquals(result.coverageGap.corruptLines, [3]);
        const text = await Deno.readTextFile(path);
        assert(text.includes('broken-interior\n{"v":1,"event":"legacy"}\n'));
        assert(text.includes('"reason":"interior_corruption"'));
    });
});

Deno.test("disk failure returns not-persisted evidence and never throws", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.mkdir(path);
        const result = await appendWorkflowMetric(path, projectRoot, metric, {
            enabled: true,
            epoch: "initial",
            deadline: Date.now() + 1000,
        });
        assertEquals(result.persisted, false);
        assertEquals(result.reason, "storage_failure");
    });
});

Deno.test("pending recorder rechecks settings after acquiring the journal lock", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        const release = lockfile.lockSync(join(dirname(path), ".journal.lock"), { realpath: false });
        const pending = recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        try {
            await new Promise((resolve) => setTimeout(resolve, 40));
            await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        } finally {
            release();
        }
        assertEquals((await pending).persisted, false);
        const secondRelease = lockfile.lockSync(join(dirname(path), ".journal.lock"), { realpath: false });
        const disabled = recordWorkflowMetric({ ...metric, seq: 2 }, projectRoot);
        try {
            await new Promise((resolve) => setTimeout(resolve, 40));
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        } finally {
            secondRelease();
        }
        assertEquals((await disabled).persisted, false);
        assertEquals((await readMetrics()).length, 1);
    });
});

Deno.test("first enabled invocation that settles disabled creates a rejecting boundary", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const started = invocation(path);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        const failed = await appendWorkflowMetric(path, projectRoot, { ...metric, eventId: "first" }, started);
        assertEquals(failed.persisted, false);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const retried = await recordWorkflowMetric(failed, projectRoot);
        assertEquals(retried.persisted, false);
        assertEquals(retried.eventId, "first");
        assertEquals((await readJournal(path)).map((row) => row.enabled), [false, true]);
    });
});

Deno.test("first post-enable batch persists without accepting earlier epoch retries", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const old = await recordWorkflowMetric(metric, projectRoot);
        assert(typeof old.collectionEpoch === "string");
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const batch = await Promise.all([1, 2, 3].map((seq) => recordWorkflowMetric({ ...metric, seq }, projectRoot)));
        assertEquals(batch.map((row) => row.persisted), [true, true, true]);
        assertEquals(new Set(batch.map((row) => row.collectionEpoch)).size, 1);
        const stale = await appendWorkflowMetric(path, projectRoot, metric, {
            enabled: true,
            epoch: old.collectionEpoch,
            deadline: Date.now() + 1000,
        });
        assertEquals(stale.reason, "collection_boundary");
        assertEquals((await readMetrics()).length, 4);
    });
});

Deno.test("large checkpointed history does not delay enabled or disabled observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        const statePath = join(dirname(path), "state.json");
        const state = JSON.parse(await Deno.readTextFile(statePath));
        const retained = ('{"v":1,"event":"legacy","padding":"' + "x".repeat(1024) + '"}\n').repeat(32768);
        await Deno.writeTextFile(path, retained, { append: true });
        state.journalBytes = (await Deno.stat(path)).size;
        state.journalLines += 32768;
        await Deno.writeTextFile(statePath, JSON.stringify(state));
        const start = Date.now();
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, true);
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).reason, "disabled");
        assert(Date.now() - start < 1400);
        const disabledEpoch = resolveCollectionEpoch(path).collectionEpoch.id;
        // Each bounded recovery call advances the checkpoint without replaying activity.
        await Deno.remove(statePath);
        let recovered;
        for (let attempt = 0; attempt < 200; attempt++) {
            const recoveryStart = Date.now();
            recovered = await recordWorkflowMetric(metric, projectRoot);
            assert(Date.now() - recoveryStart < 1400);
            if (recovered.reason !== "recovery_pending") break;
        }
        assert(recovered);
        assertEquals(recovered.reason, "disabled");
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const saved = await recordWorkflowMetric(metric, projectRoot);
        assertEquals(saved.persisted, true);
        assertEquals(saved.historyEpoch, state.historyEpoch);
        assertEquals(saved.collectionEpoch, `enabled:${disabledEpoch}`);
    });
});

Deno.test("large legacy journal builds a checkpoint and resumes enabled recording", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await Deno.mkdir(dirname(path), { recursive: true });
        // One row also spans a recovery chunk, including a multibyte character.
        const retained = JSON.stringify({ v: 1, event: "legacy", padding: "é".repeat(300000) }) + "\n";
        await Deno.writeTextFile(path, retained);
        const results = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            const start = Date.now();
            const result = await recordWorkflowMetric(metric, projectRoot);
            assert(Date.now() - start < 1400);
            results.push(result);
            if (result.persisted) break;
            assertEquals(result.reason, "recovery_pending");
        }
        const saved = results.at(-1);
        assert(saved);
        assertEquals(saved.persisted, true);
        assert((await Deno.readTextFile(path)).startsWith(retained));
        assertEquals((await readMetrics()).filter((row) => row.v === 2).length, 1);
        assertEquals((await readJournal(path)).filter((row) => row.event === "measurement_gap").length, 0);
    });
});

Deno.test("behind checkpoint recovers distant boundaries and gaps without accepting old retries", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const old = await recordWorkflowMetric(metric, projectRoot);
        const statePath = join(dirname(path), "state.json");
        const behind = await Deno.readTextFile(statePath);
        const retained = ('{"v":1,"event":"legacy","padding":"' + "x".repeat(1024) + '"}\n').repeat(600);
        await Deno.writeTextFile(path, "broken-interior\n", { append: true });
        await Deno.writeTextFile(path, retained, { append: true });
        await Deno.writeTextFile(
            path,
            JSON.stringify({
                v: 1,
                event: "collection_epoch",
                collectionEpoch: "distant-disabled",
                enabled: false,
                historyEpoch: old.historyEpoch,
            }) + "\n",
            { append: true },
        );
        // A stale checkpoint has not seen the large suffix or its disabled boundary.
        await Deno.writeTextFile(statePath, behind);
        const results = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            const result = await recordWorkflowMetric(metric, projectRoot);
            results.push(result);
            if (result.persisted) break;
            assertEquals(result.reason, "recovery_pending");
        }
        const saved = results.at(-1);
        assert(saved);
        assertEquals(saved.persisted, true);
        assertEquals(saved.collectionEpoch, "enabled:distant-disabled");
        assertEquals(saved.historyEpoch, old.historyEpoch);
        assert(saved.coverageGap);
        assertEquals(saved.coverageGap.corruptLines, [3]);
        assertEquals(
            (await recordWorkflowMetric({ ...old, persisted: false, collectionEnabledAtCall: true }, projectRoot))
                .reason,
            "collection_boundary",
        );
        assert((await Deno.readTextFile(path)).includes(retained));
    });
});

Deno.test("paused OS-lock owner cannot be displaced by an expired lease", async () => {
    if (Deno.build.os === "windows") return;
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        await recordWorkflowMetric(metric, projectRoot);
        const lockPath = join(dirname(path), ".journal.lock");
        const script = join(projectRoot, "paused-lock.js");
        await Deno.writeTextFile(
            script,
            `import lockfile from "proper-lockfile";
const guard = Deno.openSync(Deno.args[0], {read:true, write:true});
guard.lockSync(true);
const release = lockfile.lockSync(Deno.args[1], {realpath:false});
console.log("ready"); await Deno.stdin.read(new Uint8Array(1));
release(); guard.close();`,
        );
        const child = new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "-A",
                "--config",
                new URL("../../../deno.json", import.meta.url).pathname,
                script,
                join(dirname(path), ".journal.guard"),
                lockPath,
            ],
            stdin: "piped",
            stdout: "piped",
        }).spawn();
        const reader = child.stdout.getReader();
        await reader.read();
        child.kill("SIGSTOP");
        try {
            const expired = new Date(Date.now() - 60000);
            await Deno.utime(`${lockPath}.lock`, expired, expired);
            const result = await recordWorkflowMetric(metric, projectRoot);
            assertEquals(result.reason, "lock_timeout");
            assertEquals(result.persisted, false);
            assertEquals((await Deno.stat(`${lockPath}.lock`)).isDirectory, true);
        } finally {
            child.kill("SIGCONT");
            const writer = child.stdin.getWriter();
            await writer.write(new Uint8Array([10]));
            await writer.close();
            writer.releaseLock();
            assertEquals((await child.status).code, 0);
            await reader.cancel();
            reader.releaseLock();
        }
        assertEquals((await recordWorkflowMetric(metric, projectRoot)).persisted, true);
    });
});

Deno.test("interrupted tail repair retains its gap and earlier observations", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const first = await recordWorkflowMetric(metric, projectRoot);
        const end = (await Deno.stat(path)).size;
        const gap = JSON.stringify({
            v: 1,
            event: "measurement_gap",
            reason: "incomplete_append",
            tornBytes: 12,
            historyEpoch: resolveCollectionEpoch(path).historyEpoch,
        }) + "\n";
        await Deno.writeTextFile(join(dirname(path), "repair.json"), JSON.stringify({ end, gap }));
        // The original writer stopped after removing the torn bytes, before appending the gap.
        const next = await recordWorkflowMetric({ ...metric, seq: 1 }, projectRoot);
        assertEquals(next.persisted, true);
        const rows = await readJournal(path);
        assertEquals(rows.filter((row) => row.eventId === first.eventId).length, 1);
        assertEquals(rows.filter((row) => row.event === "measurement_gap").length, 1);
        assertEquals(rows.filter((row) => row.v === 2).length, 2);
    });
});

Deno.test("first-ever pending append with an earlier timestamp survives empty-history clear", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const path = getWorkflowMetricsFilePath(projectRoot);
        const state = resolveCollectionEpoch(path, true);
        assertEquals(state.historyEpoch, "initial");
        const pending = { ...metric, ts: "2020-01-01T00:00:00Z", eventId: "command_started:first" };
        const cleared = await clearWorkflowMetricJournal(path);
        assertEquals(cleared.persisted, true);
        const result = await appendWorkflowMetric(path, projectRoot, pending, {
            enabled: true,
            epoch: state.collectionEpoch.id,
            historyEpoch: state.historyEpoch,
            deadline: Date.now() + 1000,
        });
        assertEquals(result.persisted, true);
        assertEquals(result.historyEpoch, cleared.historyEpoch);
        assertEquals((await readJournal(path)).filter((row) => row.eventId === pending.eventId).length, 1);
    });
});
