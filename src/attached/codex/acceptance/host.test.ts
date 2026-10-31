import { test } from "node:test";
import { deepStrictEqual as equal, rejects, throws } from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost, HostAuthenticationError } from "./host.ts";
import { isolatedLiveHostEnv } from "./world.ts";

async function withHost(source: string, run: (host: CodexHost, root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "codex-host-test-"));
    const executable = join(root, "codex");
    await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    const host = new CodexHost({ executable, root, cwd: root, env: process.env, run: "probe", args: [] });
    try {
        await run(host, root);
    } finally {
        await host.stop();
        await rm(root, { recursive: true, force: true });
    }
}
test("real subprocess carrier correlates JSON-RPC responses and discards unrelated text", async () => {
    await withHost(
        `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(q.id)process.stdout.write(JSON.stringify({id:q.id,result:{echo:q.method}})+"\\n");}});
`,
        async (host, root) => {
            equal(await host.request("test", {}), { echo: "test" });
            equal((await readFile(join(root, "host-evidence.jsonl"), "utf8")).includes("test"), false);
        },
    );
});
test("malformed subprocess output cannot be treated as a successful host response", async () => {
    await withHost(`process.stdin.on("data",()=>console.log("not-json"));`, async (host) => {
        await rejects(host.request("test", {}), /malformed/);
    });
});
test("subprocess loss releases pending requests; a timeout never creates successful evidence", async () => {
    await withHost(`process.stdin.on("data",()=>process.exit(0));`, async (host) => {
        await rejects(host.request("test", {}), /ended/);
    });
    await withHost(`process.stdin.resume();`, async (host) => {
        await rejects(host.request("test", {}, 20), /timed out/);
    });
});
test("exec input closes before a successful turn is awaited", async () => {
    await withHost(
        `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"turn.completed"})));`,
        async (host) => {
            host.endInput();
            await host.finish(5000);
            equal(
                host.observations.some((row) => row.kind === "turn"),
                true,
            );
        },
    );
});
test("live child retains auth location without inheriting parent task or tool sockets", () => {
    equal(
        isolatedLiveHostEnv({
            HOME: "/host/home",
            CODEX_HOME: "/host/codex",
            CODEX_THREAD_ID: "parent",
            CODEX_SESSION_ID: "parent-session",
            CODEX_APP_TOOLS_PIPE_PATH: "/parent/socket",
            OPENAI_API_KEY: "host-only-marker",
        }),
        { HOME: "/host/home", CODEX_HOME: "/host/codex", OPENAI_API_KEY: "host-only-marker" },
    );
});
test("raw spawn IDs join native child activity and direct events without resuming ephemeral children", async () => {
    await withHost(
        `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const send=x=>console.log(JSON.stringify(x));
if(q.method==="trigger"){
send({method:"rawResponseItem/completed",params:{threadId:"parent",item:{type:"function_call",name:"spawn_agent",call_id:"spawn",arguments:JSON.stringify({fork_turns:"none",model:"native-model",reasoning_effort:"high",message:"DO-NOT-PERSIST"})}}});
send({method:"item/started",params:{threadId:"parent",item:{type:"subAgentActivity",id:"spawn",agentThreadId:"child"}}});
}
if(q.id)send({id:q.id,result:{}});
if(q.method==="thread/resume")process.exit(1);
if(q.method==="trigger")send({method:"item/completed",params:{threadId:"child",item:{type:"mcpToolCall",server:"runwield",tool:"get_instructions",id:"read",result:{structuredContent:{ok:true,actionId:"action",workflowId:"workflow"}}}}});
}});`,
        async (host, root) => {
            await host.request("trigger", {});
            await host.waitForCore((state) => state.actionId === "action", 5000);
            equal(host.observations.find((row) => row.kind === "worker")?.freshContext, true);
            equal(host.observations.find((row) => row.kind === "worker")?.model, "native-model");
            equal(host.observations.find((row) => row.kind === "worker")?.reasoningEffort, "high");
            equal(host.observations.find((row) => row.kind === "tool")?.threadId, "child");
            equal((await readFile(join(root, "host-evidence.jsonl"), "utf8")).includes("DO-NOT-PERSIST"), false);
        },
    );
});
for (const context of ["all", "inherited", undefined]) {
    test(`native subprocess spawn with ${context ?? "missing"} context cannot be fresh`, async () => {
        await withHost(
            `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const send=x=>console.log(JSON.stringify(x));
send({method:"rawResponseItem/completed",params:{threadId:"parent",item:{type:"function_call",name:"spawn_agent",call_id:"real-call",arguments:${JSON.stringify(JSON.stringify({ fork_turns: context }))}}}});
send({method:"item/started",params:{threadId:"parent",item:{type:"subAgentActivity",id:"wrong-call",agentThreadId:"unrelated-child"}}});
send({method:"item/started",params:{threadId:"wrong-parent",item:{type:"subAgentActivity",id:"real-call",agentThreadId:"wrong-parent-child"}}});
send({method:"item/started",params:{threadId:"parent",item:{type:"subAgentActivity",id:"real-call",agentThreadId:"actual-child"}}});
if(q.id)send({id:q.id,result:{}});
}});`,
            async (host) => {
                await host.request("trigger", {});
                equal(
                    host.observations.filter((row) => row.kind === "worker"),
                    [
                        {
                            run: "probe",
                            kind: "worker",
                            threadId: "parent",
                            toolId: "real-call",
                            workerIds: ["actual-child"],
                            freshContext: false,
                        },
                    ],
                );
            },
        );
    });
}
test("authentication preflight uses native read-only account state without recording account details", async () => {
    for (const authenticated of [false, true]) {
        await withHost(
            `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
if(q.method!=="account/read"||q.params.refreshToken!==false)process.exit(1);
console.log(JSON.stringify({id:q.id,result:{requiresOpenaiAuth:true,account:${authenticated ? '{type:"chatgpt",email:"PRIVATE-ACCOUNT",token:"PRIVATE-TOKEN"}' : "null"}}}));
}});`,
            async (host, root) => {
                if (authenticated) await host.requireAuthentication();
                else
                    await rejects(host.requireAuthentication(), {
                        name: "Error",
                        message: "Codex host authentication missing",
                    });
                equal((await readFile(join(root, "host-evidence.jsonl"), "utf8")).includes("PRIVATE-"), false);
            },
        );
    }
});
test("native RPC and turn authentication errors retain only a bounded category", async () => {
    for (const error of [
        { codexErrorInfo: "unauthorized", message: "PRIVATE-TOKEN" },
        { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, message: "PRIVATE-TOKEN" },
        { code: 401, message: "PRIVATE-TOKEN" },
        { code: -32603, message: "Refresh token expired: PRIVATE-TOKEN" },
    ]) {
        for (const rpc of [true, false]) {
            await withHost(
                `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
if(q.method==="thread/start")console.log(JSON.stringify({id:q.id,result:{thread:{id:"parent"}}}));
else ${
                    rpc
                        ? `console.log(JSON.stringify({id:q.id,error:${JSON.stringify(error)}}));`
                        : `{
console.log(JSON.stringify({id:q.id,result:{}}));
console.log(JSON.stringify({method:"turn/completed",params:{threadId:"parent",turn:{status:"failed",error:${JSON.stringify(error)}}}}));
}`
                }
}});`,
                async (host, root) => {
                    await host.startThread();
                    const failed = rpc
                        ? host.request("trigger", {})
                        : host.startTurn("PRIVATE-PROMPT").then(() => host.finishTurn(5000));
                    await rejects(
                        failed,
                        (value: Error) =>
                            value instanceof HostAuthenticationError &&
                            value.reason === "rejected" &&
                            !value.message.includes("PRIVATE-"),
                    );
                    equal((await readFile(join(root, "host-evidence.jsonl"), "utf8")).includes("PRIVATE-"), false);
                },
            );
        }
    }
    await withHost(
        `process.stdin.on("data",bytes=>{const q=JSON.parse(bytes.toString());console.log(JSON.stringify({id:q.id,error:{code:500,message:"PRIVATE-TOKEN"}}));});`,
        async (host) => {
            await rejects(
                host.request("trigger", {}),
                (value: Error) =>
                    !(value instanceof HostAuthenticationError) &&
                    value.message === "Codex rejected the protocol request",
            );
        },
    );
});
test("host shutdown closes input and lets the real child cleanup cancel an unfinished subprocess", async () => {
    await withHost(
        `
const {spawn}=require("node:child_process");
const child=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),60000)"],{detached:true,stdio:"ignore"});
process.stdin.on("data",bytes=>{const q=JSON.parse(bytes.toString());console.log(JSON.stringify({id:q.id,result:{pid:child.pid}}));});
process.stdin.on("end",()=>{child.kill("SIGTERM");child.on("close",()=>process.exit(0));});
`,
        async (host) => {
            const result = await host.request("trigger", {});
            equal(typeof result.pid, "number");
            const pid = Number(result.pid);
            process.kill(pid, 0);
            try {
                await host.stop();
                throws(() => process.kill(pid, 0), { code: "ESRCH" });
            } finally {
                try {
                    process.kill(pid, "SIGKILL");
                } catch {
                    /* Already cancelled. */
                }
            }
        },
    );
});
test("tool inventory waits for native starting status to settle", async () => {
    await withHost(
        `
let buffer="",calls=0;process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
console.log(JSON.stringify({id:q.id,result:{data:[{name:"runwield",runtimeStatus:++calls===1?"starting":"connected",tools:{status:{}}}]}}));}});`,
        async (host) => {
            equal((await host.inventory()).data, [
                { name: "runwield", runtimeStatus: "connected", tools: { status: {} } },
            ]);
        },
    );
});
