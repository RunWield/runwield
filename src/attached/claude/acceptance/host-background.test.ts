import { test } from "node:test";
import { throws, deepStrictEqual as equal, rejects } from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AcceptanceWorld } from "./world.ts";
import { ClaudeHost, HostTurnEnded } from "./host.ts";
import { type JsonMap } from "./evidence.ts";
import { withExternalClaude, CHECKOUT } from "./runtime-test-fixture.ts";

// The test controls only external Claude events, independently of user messages.
const protocol = `
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const events=join(process.env.CLAUDE_CONFIG_DIR,'events');
writeFileSync(events,'');
createInterface({input:process.stdin}).on('line',line=>appendFileSync(join(process.env.CLAUDE_CONFIG_DIR,'inputs'),line+'\\n'));
let cursor=0;
setInterval(()=>{const lines=readFileSync(events,'utf8').split('\\n').filter(Boolean);
while(cursor<lines.length) process.stdout.write(lines[cursor++]+'\\n');},5);
`;
const started: JsonMap = {
    type: "system",
    subtype: "task_started",
    task_id: "reviewer",
    run_id: "review-run",
    tool_use_id: "agent-call",
    task_type: "local_agent",
    is_backgrounded: true,
};
const completed: JsonMap = {
    type: "system",
    subtype: "task_notification",
    task_id: "reviewer",
    run_id: "review-run",
    tool_use_id: "agent-call",
    status: "completed",
};
const success: JsonMap = { type: "result", subtype: "success", is_error: false };

async function emit(root: string, rows: JsonMap[]): Promise<void> {
    const input = join(root, "claude-config/events");
    for (let attempt = 0; ; attempt++) {
        try {
            await readFile(input);
            break;
        } catch (error) {
            if (attempt === 499) throw error;
            await delay(10);
        }
    }
    const marker = randomUUID();
    await appendFile(
        input,
        [...rows, { type: "system", subtype: "test_marker", uuid: marker }]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
    );
    for (let attempt = 0; attempt < 500; attempt++) {
        if ((await readFile(join(root, "logs/claude/request.jsonl"), "utf8")).includes(marker)) return;
        await delay(10);
    }
    throw new Error("External host did not emit the test events");
}
async function withHost(run: (root: string, host: ClaudeHost) => Promise<void>): Promise<void> {
    await withExternalClaude(protocol, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            await run(root, host);
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
}

test("a completed main turn waits for its live background reviewer and the next genuine Core result", async () => {
    await withHost(async (root, host) => {
        host.send("begin");
        let failure: Error | null = null;
        const waiting = host
            .waitForCore((body) => body.operation === "review_complete", 5000)
            .catch((error: Error) => {
                failure = error;
                return null;
            });
        let finished = false;
        const finishing = host.finishTurn(5000).then(
            () => {
                finished = true;
            },
            () => {},
        );
        await emit(root, [
            {
                type: "system",
                subtype: "background_tasks_changed",
                tasks: [{ task_id: "reviewer", run_id: "review-run" }],
            },
            started,
            success,
        ]);
        equal(failure, null);
        equal(host.readyForInput, false);
        equal(finished, false);
        await emit(root, [completed]);
        equal(host.readyForInput, false); // Completion queues another parent turn; it is not that turn's result.
        const emitted = emit(root, [
            {
                type: "assistant",
                message: {
                    content: [{ type: "tool_use", id: "review", name: "mcp__runwield__review_complete", input: {} }],
                },
            },
            {
                type: "user",
                message: {
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "review",
                            content: JSON.stringify({ ok: true, operation: "review_complete" }),
                        },
                    ],
                },
            },
        ]);
        equal(await waiting, { ok: true, operation: "review_complete" });
        host.resume();
        await emitted;
        await emit(root, [success]);
        await finishing;
        equal(finished, true);
        equal((await readFile(join(root, "claude-config/inputs"), "utf8")).trim().split("\n").length, 1);
    });
});

test("the background task list alone prevents an idle-turn retry before task_started arrives", async () => {
    await withHost(async (root, host) => {
        await emit(root, [
            {
                type: "system",
                subtype: "background_tasks_changed",
                tasks: [{ task_id: "reviewer", run_id: "review-run" }],
            },
            success,
        ]);
        equal(host.readyForInput, false);
        await rejects(
            host.waitForCore(() => true, 40),
            /timed out/,
        );
        await rejects(host.finishTurn(40), /timed out/);
    });
});

for (const [name, event] of [
    ["another task", { ...completed, task_id: "another" }],
    ["another run", { ...completed, run_id: "old-review-run" }],
    ["unknown status", { ...completed, status: "not-reported" }],
    [
        "unstructured text",
        {
            type: "assistant",
            parent_tool_use_id: "agent-call",
            message: { content: [{ type: "text", text: JSON.stringify(completed) }] },
        },
    ],
] satisfies [string, JsonMap][])
    test(`a live reviewer remains pending after ${name}`, async () => {
        await withHost(async (root, host) => {
            await emit(root, [started, success, event, success]);
            equal(host.readyForInput, false);
            await rejects(
                host.waitForCore(() => true, 40),
                /timed out/,
            );
        });
    });

test("all concurrent tasks must complete before an idle main turn can request continuation", async () => {
    await withHost(async (root, host) => {
        await emit(root, [
            started,
            { ...started, task_id: "second", run_id: "second-run" },
            success,
            completed,
            success,
        ]);
        equal(host.readyForInput, false);
        await emit(root, [{ ...completed, task_id: "second", run_id: "second-run" }, success]);
        equal(host.readyForInput, true);
        await rejects(
            host.waitForCore(() => true),
            HostTurnEnded,
        );
        await host.finishTurn();
    });
});

test("foreground worker completion preserves normal main-turn completion", async () => {
    await withHost(async (root, host) => {
        await emit(root, [{ ...started, is_backgrounded: false }, completed, success]);
        equal(host.readyForInput, true);
        await host.finishTurn();
    });
});

test("a forwarded child result does not end the parent turn", async () => {
    await withHost(async (root, host) => {
        await emit(root, [{ ...success, parent_tool_use_id: "agent-call" }]);
        equal(host.readyForInput, false);
        await rejects(
            host.waitForCore(() => true, 40),
            /timed out/,
        );
    });
});

test("a failed parent turn is terminal even with a live background reviewer", async () => {
    await withHost(async (root, host) => {
        const waiting = rejects(
            host.waitForCore(() => true, 500),
            /did not succeed/,
        );
        await emit(root, [started, { type: "result", subtype: "error", is_error: true }]);
        await waiting;
        await rejects(
            host.waitForCore(() => true, 500),
            /did not succeed/,
        );
        await rejects(host.finishTurn(), /did not succeed/);
        throws(() => host.readyForInput, /did not succeed/);
    });
});

for (const [name, event] of [
    ["task identity", { type: "system", subtype: "task_started", task_id: "" }],
    ["task list", { type: "system", subtype: "background_tasks_changed", tasks: null }],
    [
        "listed task identity",
        { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "reviewer", run_id: 42 }] },
    ],
] satisfies [string, JsonMap][])
    test(`an unreadable ${name} cannot establish an idle host`, async () => {
        await withHost(async (root, host) => {
            const waiting = rejects(
                host.waitForCore(() => true),
                (error) => error instanceof Error && !(error instanceof HostTurnEnded),
            );
            await emit(root, [event, success]);
            await waiting;
            throws(() => host.readyForInput);
        });
    });

test("a complete live task snapshot repairs a missed terminal notification without reusing the old parent result", async () => {
    await withHost(async (root, host) => {
        await emit(root, [started, success]);
        equal(host.readyForInput, false);
        await emit(root, [{ type: "system", subtype: "background_tasks_changed", tasks: [] }]);
        equal(host.readyForInput, false);
        const waiting = rejects(
            host.waitForCore(() => true, 1000),
            HostTurnEnded,
        );
        await emit(root, [success]);
        await waiting;
        equal(host.readyForInput, true);
    });
});

for (const status of ["failed", "stopped"])
    test(`a ${status} worker permits parent recovery but does not supply a Core checkpoint`, async () => {
        await withHost(async (root, host) => {
            await emit(root, [started, success, { ...completed, status }]);
            equal(host.readyForInput, false);
            const waiting = rejects(
                host.waitForCore(() => true, 1000),
                HostTurnEnded,
            );
            await emit(root, [success]);
            await waiting;
            equal(host.readyForInput, true);
        });
    });

test("legacy task messages without run_id match by their shared task_id", async () => {
    await withHost(async (root, host) => {
        const start = { ...started };
        const end = { ...completed };
        delete start.run_id;
        delete end.run_id;
        await emit(root, [start, success]);
        equal(host.readyForInput, false);
        await emit(root, [end, success]);
        equal(host.readyForInput, true);
    });
});

test("parent activity invalidates the preceding idle result", async () => {
    await withHost(async (root, host) => {
        await emit(root, [success]);
        equal(host.readyForInput, true);
        await emit(root, [
            {
                type: "assistant",
                parent_tool_use_id: null,
                message: { content: [{ type: "text", text: "Continuing." }] },
            },
        ]);
        equal(host.readyForInput, false);
        await rejects(
            host.waitForCore(() => true, 40),
            /timed out/,
        );
    });
});

test("process loss while a reviewer is active fails instead of waiting or spending another turn", async () => {
    await withHost(async (root, host) => {
        await emit(root, [started, success]);
        const waiting = rejects(
            host.waitForCore(() => true, 1000),
            /exited/,
        );
        await host.stop("interrupted", "SIGKILL");
        await waiting;
        throws(() => host.readyForInput, /exited/);
    });
});

for (const [name, event] of [
    ["start", { ...started, ambient: true }],
    [
        "snapshot",
        {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "watcher", run_id: "watch-run", ambient: true }],
        },
    ],
] satisfies [string, JsonMap][])
    test(`an ambient-only ${name} neither blocks nor invalidates an idle parent`, async () => {
        await withHost(async (root, host) => {
            await emit(root, [event, success]);
            equal(host.readyForInput, true);
            await emit(root, [event]);
            equal(host.readyForInput, true);
            await host.finishTurn(100);
        });
    });

test("a redundant empty snapshot after the resumed parent result preserves that result", async () => {
    await withHost(async (root, host) => {
        await emit(root, [started, success, completed, success]);
        equal(host.readyForInput, true);
        await emit(root, [{ type: "system", subtype: "background_tasks_changed", tasks: [] }]);
        equal(host.readyForInput, true);
        await host.finishTurn(100);
        await rejects(
            host.waitForCore(() => true, 100),
            HostTurnEnded,
        );
    });
});
