import { test } from "node:test";
import { deepStrictEqual as equal, ok as assert, rejects } from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcceptanceWorld } from "./world.ts";
import { attachedValidationFixture } from "../../../shared/attached/validation-test-fixture.ts";
import { getExactProjectCustomSetting } from "../../../shared/settings.js";
import { withExternalClaude, CHECKOUT } from "./runtime-test-fixture.ts";

// The external host starts a real detached CI shell, as the foreground validation runner does.
const hostWithCi = `
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createInterface} from 'node:readline';
const marker=join(dirname(process.env.CLAUDE_CONFIG_DIR),'markers');
createInterface({input:process.stdin}).once('line',()=>{
 const child=spawn('/bin/sh',['-c', 'printf "%s\\n" "$$" >> "$1/ci-runs"; while kill -0 "$2" 2>/dev/null; do sleep 0.01; done; printf "%s\\n" "$$" >> "$1/ci-finished"', 'ci',marker,String(process.pid)],{detached:true,stdio:'ignore'});
 child.unref();
 const rows=[{type:'assistant',message:{content:[{type:'tool_use',id:'ci',name:'mcp__runwield__status',input:{}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'ci',content:JSON.stringify({ok:true,operation:'status',ciPid:child.pid})}]}}];
 process.stdout.write(rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
});
`;

test("CI remains held through the real host kill and both evidence snapshots, then is released", async () => {
    await withExternalClaude(hostWithCi, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("validate", "ci-started");
        let ciPid = 0;
        const stopCi = () => {
            if (ciPid) {
                try {
                    process.kill(ciPid, "SIGKILL");
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
                }
            }
        };
        try {
            host.send("validate");
            const body = await host.waitForCore((body) => body.operation === "status");
            assert(typeof body.ciPid === "number");
            ciPid = body.ciPid;
            for (let attempt = 0; attempt < 100; attempt++) {
                if ((await readFile(join(root, "markers/ci-runs"), "utf8")).trim()) break;
                await delay(10);
            }
            await world.interruptCi(host);
            for (const phase of ["ci-started", "ci-killed"]) {
                const snapshot = JSON.parse(await readFile(join(root, "snapshots", `${phase}.json`), "utf8"));
                equal(snapshot.hostRun, "validate");
                equal(snapshot.ciRuns, [String(ciPid)]);
                equal(snapshot.ciFinished, []);
                equal(snapshot.errors, []);
            }
            const processes = (await readFile(join(root, "logs/processes.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((row) => JSON.parse(row));
            assert(
                processes.some((row) => row.event === "exit" && row.runId === "validate" && row.signal === "SIGKILL"),
            );
            assert(processes.some((row) => row.event === "ci-held" && row.ciPid === ciPid));
            for (let attempt = 0; attempt < 100; attempt++) {
                if ((await readFile(join(root, "markers/ci-finished"), "utf8")).trim()) break;
                await delay(10);
            }
            equal((await readFile(join(root, "markers/ci-finished"), "utf8")).trim(), String(ciPid));
        } finally {
            await host.stop("cleanup", "SIGKILL");
            stopCi();
            await world.close();
        }
    });
});

// Claude may end its turn to ask the user for the unconfigured project's command.
const awaitingCommand = `
import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const root=dirname(process.env.CLAUDE_CONFIG_DIR);
let turns=0;
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line).message.content;
 appendFileSync(join(root,'host-inputs.jsonl'),JSON.stringify(message)+'\\n');
 if(++turns===2 && message.includes('sh ./check.sh'))
   appendFileSync(join(root,'markers/ci-runs'),String(process.pid)+'\\n');
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));
});
`;

test("CI startup supplies the selected command after Claude ends a turn to ask the user", async () => {
    await withExternalClaude(awaitingCommand, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("validate", "ci-started");
        try {
            host.send("/runwield:validate");
            await world.waitForCiStart(host, 0, 2000);
            equal(
                (await readFile(join(root, "markers/ci-runs"), "utf8")).trim(),
                String(
                    JSON.parse((await readFile(join(root, "logs/processes.jsonl"), "utf8")).trim().split("\n")[0]).pid,
                ),
            );
            const messages = (await readFile(join(root, "host-inputs.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            equal(messages.length, 2);
            assert(messages[1].includes("sh ./check.sh"));
            const snapshot = await world.snapshot("ci-started", "validate");
            equal(
                snapshot.files.some((file) => file.path.startsWith("fixture/.wld/")),
                false,
            );
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});

for (const [name, source, error] of [
    [
        "failed host turn",
        "console.log(JSON.stringify({type:'result',subtype:'error',is_error:true}));setInterval(()=>{},1000);",
        /did not succeed/,
    ],
    ["silent host", "setInterval(()=>{},1000);", /deadline/],
    ["closed host", "process.exit(0);", /exited/],
] as const)
    test(`CI startup fails promptly for a ${name}`, async () => {
        await withExternalClaude(source, async (root, claude) => {
            const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
            const host = world.startHost("validate", "ci-started");
            try {
                host.send("/runwield:validate");
                await rejects(world.waitForCiStart(host, 0, 500), error);
                equal(await readFile(join(root, "markers/ci-runs"), "utf8"), "");
            } finally {
                await host.stop("cleanup", "SIGKILL");
                await world.close();
            }
        });
    });

test("CI startup limits completed-turn retries rather than sending unbounded model turns", async () => {
    const noCi = awaitingCommand.replace("if(++turns===2 && message.includes('sh ./check.sh'))", "if(false)");
    await withExternalClaude(noCi, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        const host = world.startHost("validate", "ci-started");
        try {
            host.send("/runwield:validate");
            await rejects(world.waitForCiStart(host, 0, 3000), /after the user command answer/);
            equal((await readFile(join(root, "host-inputs.jsonl"), "utf8")).trim().split("\n").length, 6);
        } finally {
            await host.stop("cleanup", "SIGKILL");
            await world.close();
        }
    });
});

test("Core accepts the user's text command and starts real CI after rejecting a selection-shaped answer", async () => {
    const fixture = await attachedValidationFixture({ command: null });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
        await writeFile(join(fixture.cwd, "check.sh"), await readFile(join(fixture.cwd, "verify.sh")));
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "validation");
        assert(started.workflow.nextAction.request.kind === "decision");
        equal(started.workflow.nextAction.request.interaction.type, "text");
        const invalid = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "sh ./check.sh" },
        });
        assert(!invalid.ok);
        equal(invalid.rejection.code, "invalid_outcome");
        equal(await fixture.ciCount(), 0);
        const restored = await fixture.call("start_validation", await fixture.status());
        assert(restored.ok && restored.workflow.nextAction.kind === "validation");
        const answered = await fixture.call("validation_decision", restored.workflow, {
            actionId: restored.workflow.nextAction.actionId,
            answer: { outcome: "text", value: "sh ./check.sh" },
        });
        assert(answered.ok && answered.workflow.nextAction.kind === "validation");
        equal(answered.workflow.nextAction.request.kind, "reviewer");
        equal(await fixture.ciCount(), 1);
        equal(getExactProjectCustomSetting("verification_command", fixture.cwd), "sh ./check.sh");
    } finally {
        await fixture.close();
    }
});
