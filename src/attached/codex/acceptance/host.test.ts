import { test } from "node:test";
import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "./host.ts";
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
test("raw spawn call IDs join native child activity and subscribe to direct worker results", async () => {
    await withHost(
        `
let buffer="";process.stdin.on("data",bytes=>{buffer+=bytes;let n;while((n=buffer.indexOf("\\n"))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const send=x=>console.log(JSON.stringify(x));
if(q.method==="trigger"){
send({method:"rawResponseItem/completed",params:{threadId:"parent",item:{type:"function_call",name:"spawn_agent",call_id:"spawn",arguments:JSON.stringify({fork_turns:"none",message:"DO-NOT-PERSIST"})}}});
send({method:"item/started",params:{threadId:"parent",item:{type:"subAgentActivity",id:"spawn",agentThreadId:"child"}}});
}
if(q.id)send({id:q.id,result:{}});
if(q.method==="thread/resume")send({method:"item/completed",params:{threadId:q.params.threadId,item:{type:"mcpToolCall",server:"runwield",tool:"get_instructions",id:"read",result:{structuredContent:{ok:true,actionId:"action",workflowId:"workflow"}}}}});
}});`,
        async (host, root) => {
            await host.request("trigger", {});
            await host.waitForCore((state) => state.actionId === "action", 5000);
            equal(host.observations.find((row) => row.kind === "worker")?.freshContext, true);
            equal(host.observations.find((row) => row.kind === "tool")?.threadId, "child");
            equal((await readFile(join(root, "host-evidence.jsonl"), "utf8")).includes("DO-NOT-PERSIST"), false);
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
