import { test } from "node:test";
import { throws, deepStrictEqual as equal, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AcceptanceWorld } from "./world.ts";
import { ClaudeHost, HostTurnEnded } from "./host.ts";
import { type JsonMap } from "./evidence.ts";
import { withExternalClaude, CHECKOUT } from "./runtime-test-fixture.ts";

// The test controls only external Claude events, independently of user messages.
const protocol = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
const mark=(uuid)=>({type:'system',subtype:'test_marker',uuid});
createInterface({input:process.stdin}).on('line',line=>{
const batch=JSON.parse(line);
if(Array.isArray(batch.fixtureEvents)) {
    // Queue the complete batch in one write. Core can pause the fake process
    // in response to a row; no marker must be stranded after that row.
    process.stdout.write([...batch.fixtureEvents,mark(batch.marker)].map(row=>JSON.stringify(row)).join('\\n')+'\\n');
} else appendFileSync(join(process.env.CLAUDE_CONFIG_DIR,'inputs'),line+'\\n');
});
process.stdout.write(JSON.stringify(mark('ready'))+'\\n');
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

const FIXTURE_DEADLINE_MS = 5000;

async function emit(host: ClaudeHost, rows: JsonMap[]): Promise<void> {
    await host.fixtureExchange(randomUUID(), FIXTURE_DEADLINE_MS, rows);
}
async function withHost(run: (root: string, host: ClaudeHost) => Promise<void>): Promise<void> {
    await withExternalClaude(protocol, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            await host.fixtureExchange("ready", FIXTURE_DEADLINE_MS);
            await run(root, host);
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
}

test("fixture readiness reports the child exit instead of waiting for its watchdog", async () => {
    await withExternalClaude("process.exit(17);", async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            await rejects(
                host.fixtureExchange("ready", FIXTURE_DEADLINE_MS),
                /child exited \(code=17, signal=none\).*ready=false/,
            );
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});

test("fixture consumption reports a ready child that exits before acknowledging the batch", async () => {
    const exitsOnBatch = [
        "import {createInterface} from 'node:readline';",
        "createInterface({input:process.stdin}).once('line', () => process.exit(18));",
        "console.log(JSON.stringify({type:'system',subtype:'test_marker',uuid:'ready'}));",
    ].join("\n");
    await withExternalClaude(exitsOnBatch, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            await host.fixtureExchange("ready", FIXTURE_DEADLINE_MS);
            await rejects(emit(host, [success]), /child exited \(code=18, signal=none\).*ready=true/);
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});

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
        let finishFailure: Error | null = null;
        const finishing = host.finishTurn(5000).then(
            () => {
                finished = true;
            },
            (error: Error) => {
                finishFailure = error;
            },
        );
        await emit(host, [
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
        await emit(host, [completed]);
        equal(host.readyForInput, false); // Completion queues another parent turn; it is not that turn's result.
        const emitted = emit(host, [
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
        try {
            equal(await waiting, { ok: true, operation: "review_complete" });
        } finally {
            host.resume();
            await emitted;
        }
        await emit(host, [success]);
        await finishing;
        equal(finishFailure, null);
        equal(finished, true);
        equal((await readFile(join(root, "claude-config/inputs"), "utf8")).trim().split("\n").length, 1);
    });
});

test("the background task list alone prevents an idle-turn retry before task_started arrives", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [
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
        await withHost(async (_root, host) => {
            await emit(host, [started, success, event, success]);
            equal(host.readyForInput, false);
            await rejects(
                host.waitForCore(() => true, 40),
                /timed out/,
            );
        });
    });

test("all concurrent tasks must complete before an idle main turn can request continuation", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [
            started,
            { ...started, task_id: "second", run_id: "second-run" },
            success,
            completed,
            success,
        ]);
        equal(host.readyForInput, false);
        await emit(host, [{ ...completed, task_id: "second", run_id: "second-run" }, success]);
        equal(host.readyForInput, true);
        await rejects(
            host.waitForCore(() => true),
            HostTurnEnded,
        );
        await host.finishTurn();
    });
});

test("foreground worker completion preserves normal main-turn completion", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [{ ...started, is_backgrounded: false }, completed, success]);
        equal(host.readyForInput, true);
        await host.finishTurn();
    });
});

test("a forwarded child result does not end the parent turn", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [{ ...success, parent_tool_use_id: "agent-call" }]);
        equal(host.readyForInput, false);
        await rejects(
            host.waitForCore(() => true, 40),
            /timed out/,
        );
    });
});

test("a failed parent turn is terminal even with a live background reviewer", async () => {
    await withHost(async (_root, host) => {
        const waiting = rejects(
            host.waitForCore(() => true, 500),
            /did not succeed/,
        );
        await emit(host, [started, { type: "result", subtype: "error", is_error: true }]);
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
        await withHost(async (_root, host) => {
            const waiting = rejects(
                host.waitForCore(() => true),
                (error) => error instanceof Error && !(error instanceof HostTurnEnded),
            );
            await emit(host, [event, success]);
            await waiting;
            throws(() => host.readyForInput);
        });
    });

test("a complete live task snapshot repairs a missed terminal notification without reusing the old parent result", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [started, success]);
        equal(host.readyForInput, false);
        await emit(host, [{ type: "system", subtype: "background_tasks_changed", tasks: [] }]);
        equal(host.readyForInput, false);
        const waiting = rejects(
            host.waitForCore(() => true, 1000),
            HostTurnEnded,
        );
        await emit(host, [success]);
        await waiting;
        equal(host.readyForInput, true);
    });
});

for (const status of ["failed", "stopped"])
    test(`a ${status} worker permits parent recovery but does not supply a Core checkpoint`, async () => {
        await withHost(async (_root, host) => {
            await emit(host, [started, success, { ...completed, status }]);
            equal(host.readyForInput, false);
            const waiting = rejects(
                host.waitForCore(() => true, 1000),
                HostTurnEnded,
            );
            await emit(host, [success]);
            await waiting;
            equal(host.readyForInput, true);
        });
    });

test("legacy task messages without run_id match by their shared task_id", async () => {
    await withHost(async (_root, host) => {
        const start = { ...started };
        const end = { ...completed };
        delete start.run_id;
        delete end.run_id;
        await emit(host, [start, success]);
        equal(host.readyForInput, false);
        await emit(host, [end, success]);
        equal(host.readyForInput, true);
    });
});

test("parent activity invalidates the preceding idle result", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [success]);
        equal(host.readyForInput, true);
        await emit(host, [
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
    await withHost(async (_root, host) => {
        await emit(host, [started, success]);
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
        await withHost(async (_root, host) => {
            await emit(host, [event, success]);
            equal(host.readyForInput, true);
            await emit(host, [event]);
            equal(host.readyForInput, true);
            await host.finishTurn(100);
        });
    });

test("a redundant empty snapshot after the resumed parent result preserves that result", async () => {
    await withHost(async (_root, host) => {
        await emit(host, [started, success, completed, success]);
        equal(host.readyForInput, true);
        await emit(host, [{ type: "system", subtype: "background_tasks_changed", tasks: [] }]);
        equal(host.readyForInput, true);
        await host.finishTurn(100);
        await rejects(
            host.waitForCore(() => true, 100),
            HostTurnEnded,
        );
    });
});
