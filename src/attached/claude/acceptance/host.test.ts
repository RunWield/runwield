import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcceptanceWorld } from "./world.ts";
import { HostTurnEnded } from "./host.ts";
import { withExternalClaude, CHECKOUT } from "./runtime-test-fixture.ts";

const protocol = `
import { createInterface } from 'node:readline';
const emit = row => process.stdout.write(JSON.stringify(row)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 emit({type:'assistant',message:{content:[{type:'tool_use',id:'call-1',name:'mcp__plugin_runwield_runwield__status',input:{}}]}});
 emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'call-1',content:JSON.stringify({ok:true,operation:'status',workflow:{workflowId:'observed',state:'awaiting_review'}})}]}});
 setTimeout(()=>emit({type:'result',subtype:'success',is_error:false}),100);
});
`;

test("host reads real protocol events, pauses at a Core result, and records linked process identities", async () => {
    await withExternalClaude(protocol, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            host.send("begin");
            const body = await host.waitForCore((body) => body.operation === "status");
            equal(body.workflow, { workflowId: "observed", state: "awaiting_review" });
            const before = await readFile(join(root, "logs/claude/request.jsonl"), "utf8");
            await delay(200);
            equal(await readFile(join(root, "logs/claude/request.jsonl"), "utf8"), before);
            host.resume();
            await host.finishTurn();
            await host.stop("plan-killed", "SIGKILL");
            const audit = (await readFile(join(root, "logs/processes.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            equal(
                audit.map((row) => row.event),
                ["start", "exit"],
            );
            equal(audit[0].pid, audit[1].pid);
            equal(audit[0].runId, audit[1].runId);
            equal(audit[1].phase, "plan-killed");
            equal(audit[1].signal, "SIGKILL");
        } finally {
            await host.stop("cleanup");
            await world.close();
        }
    });
});

test("Bash output that resembles Core cannot supply a host checkpoint", async () => {
    await withExternalClaude(
        protocol.replace("mcp__plugin_runwield_runwield__status", "Bash"),
        async (root, claude) => {
            const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
            const host = world.startHost("request", "request");
            try {
                host.send("begin");
                await rejects(
                    host.waitForCore(() => true),
                    HostTurnEnded,
                );
            } finally {
                await host.stop("cleanup");
                await world.close();
            }
        },
    );
});

for (const [name, source] of [
    ["malformed stream", "console.log('not JSON'); setTimeout(()=>process.exit(0),100);"],
    ["truncated stream", "process.stdout.write('{');"],
    ["empty stream", "process.exit(0);"],
    [
        "failed turn",
        "console.log(JSON.stringify({type:'result',subtype:'error',is_error:true})); setTimeout(()=>process.exit(1),100);",
    ],
] as const)
    test(`host fails closed on ${name}`, async () => {
        await withExternalClaude(source, async (root, claude) => {
            const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
            const host = world.startHost("request", "request");
            try {
                await rejects(host.finishTurn(2000));
            } finally {
                await host.stop("cleanup");
                await world.close();
            }
        });
    });

test("a silent live host times out instead of reporting success", async () => {
    await withExternalClaude("setInterval(()=>{},1000);", async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            await rejects(
                host.waitForCore(() => true, 100),
                /timed out/,
            );
        } finally {
            await host.stop("cleanup");
            await world.close();
        }
    });
});

test("host CLI receives stream mode and worker traffic flags without a plugin-dir bypass", async () => {
    await withExternalClaude(
        `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.CLAUDE_CONFIG_DIR+'/argv',JSON.stringify(process.argv.slice(2)));\n` +
            protocol,
        async (root, claude) => {
            const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
            const host = world.startHost("request", "request");
            try {
                host.send("begin");
                await host.waitForCore(() => true);
                const args = JSON.parse(await readFile(join(root, "claude-config/argv"), "utf8"));
                assert(args.includes("--forward-subagent-text") && args.includes("--dangerously-skip-permissions"));
                equal(args.includes("--plugin-dir"), false);
            } finally {
                await host.stop("cleanup", "SIGKILL");
                await world.close();
            }
        },
    );
});

test("pausing the model leaves its child review listener responsive", async () => {
    const source =
        `
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const portFile=join(process.env.CLAUDE_CONFIG_DIR,'port');
const child=spawn(process.execPath,['-e', 'import{createServer}from"node:http";import{writeFileSync}from"node:fs";const s=createServer((q,r)=>r.end("alive"));s.listen(0,"127.0.0.1",()=>writeFileSync('+JSON.stringify(portFile)+',String(s.address().port)));'],{stdio:'ignore'});
` + protocol;
    await withExternalClaude(source, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            host.send("begin");
            await host.waitForCore(() => true);
            let port = "";
            for (let attempt = 0; attempt < 30 && !port; attempt++) {
                try {
                    port = await readFile(join(root, "claude-config/port"), "utf8");
                } catch {
                    await delay(20);
                }
            }
            assert(port);
            const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
            equal(await response.text(), "alive");
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});

test("a failed Core-wait turn is terminal, not a request to spend another turn", async () => {
    await withExternalClaude(
        "console.log(JSON.stringify({type:'result',subtype:'error',is_error:true})); setTimeout(()=>process.exit(1),100);",
        async (root, claude) => {
            const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
            const host = world.startHost("request", "request");
            try {
                await rejects(
                    host.waitForCore(() => true),
                    (error) => error instanceof Error && !(error instanceof HostTurnEnded),
                );
            } finally {
                await host.stop("cleanup");
                await world.close();
            }
        },
    );
});

test("buffered checkpoints stay paused instead of being resumed before capture", async () => {
    const source = `import{createInterface}from'node:readline';
createInterface({input:process.stdin}).on('line',()=>{
const rows=[]; for(const id of ['first','second']) {
rows.push({type:'assistant',message:{content:[{type:'tool_use',id,name:'mcp__runwield__status',input:{}}]}});
rows.push({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:JSON.stringify({ok:true,operation:'status',checkpoint:id})}]}});}
process.stdout.write(rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
setTimeout(()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false})),100);
});`;
    await withExternalClaude(source, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("request", "request");
        try {
            host.send("begin");
            await host.waitForCore((body) => body.checkpoint === "first");
            await host.waitForCore((body) => body.checkpoint === "second");
            const before = await readFile(join(root, "logs/claude/request.jsonl"), "utf8");
            await delay(200);
            equal(await readFile(join(root, "logs/claude/request.jsonl"), "utf8"), before);
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});
