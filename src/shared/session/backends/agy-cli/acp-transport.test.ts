import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";
import {
    removeExecutableFixtureDirectory,
    writeRuntimeExecutableFixture,
} from "../../../../testing/runtime-executable-fixture.ts";
import { runAgyAcpTurn, type AgyAcpTurnOptions } from "./acp-transport.ts";

const fixtureScript = String.raw`
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const send = (frame) => console.log(JSON.stringify({jsonrpc:"2.0", ...frame}));
const events = join(process.cwd(), "receipt");
const sessionId = "fixture-session";
let promptId;
const update = (update) => send({method:"session/update", params:{sessionId, update}});
const reply = (id, result) => send({id,result});
const requestPermission = (name, toolCallId) => send({id:toolCallId,method:"session/request_permission",params:{
    sessionId, toolCall:{name,toolCallId,kind:"other",rawInput:{toolSummary:"Marker"}},
    options:[{kind:"allow_always",optionId:"always"},{kind:"allow_once",optionId:"once"}]
}});
for await (const line of createInterface({ input:process.stdin })) {
    const {id,method,params,result} = JSON.parse(line);
    switch (method) {
        case "initialize":
            if (!process.argv.includes("--process-per-session") || process.argv.includes("-p") ||
                process.argv.includes("--dangerously-skip-permissions")) process.exit(9);
            reply(id,{protocolVersion:1}); break;
        case "session/new":
            if (params.mcpServers[0]?.name !== "marker") process.exit(8);
            reply(id,{sessionId}); break;
        case "session/set_config_option":
            reply(id,{configOptions:[
                {id:params.configId,currentValue:params.value},
                {id:"model",currentValue:"gemini-3.8-flash"}
            ]}); break;
        case "session/prompt":
            promptId=id;
            if(params.prompt[0].text === "failure") {
                update({sessionUpdate:"agent_message_chunk",content:{text:"\n⚠ failed to construct executor: invalid role"}});
                reply(id,{stopReason:"end_turn",usage:{inputTokens:5,outputTokens:1}});
            } else if(params.prompt[0].text === "permission") {
                requestPermission("mcp_marker_complete", "call-1");
            } else if(params.prompt[0].text === "denied") {
                requestPermission("mcp_unrelated_action", "call-2");
            } else {
                update({sessionUpdate:"agent_message_chunk",content:{text:"ready"}});
            }
            break;
        case "session/cancel":
            appendFileSync(events, "cancel\n");
            reply(promptId,{stopReason:"cancelled"}); break;
        case "session/close": reply(id,{}); break;
        default:
            if(result?.outcome.outcome === "selected") appendFileSync(events,result.outcome.optionId+"\n");
            update({sessionUpdate:"agent_message_chunk",content:{text:"result"}});
            reply(promptId,{stopReason:"end_turn",usage:{inputTokens:8,outputTokens:2,thoughtTokens:1}});
    }
}
`;

async function withFixture(run: (options: AgyAcpTurnOptions, receipt: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const cwd = await mkdtemp(join(tmpdir(), "agy-acp-"));
        const path = process.env.PATH;
        try {
            const source = join(cwd, "fixture.js");
            await writeFile(source, fixtureScript);
            await writeRuntimeExecutableFixture(join(cwd, "agy"), source);
            process.env.PATH = cwd + delimiter + (path || "");
            await run(
                {
                    cwd,
                    agentName: "runwield-marker",
                    model: "gemini-3.8-flash",
                    effort: "low",
                    userRequest: "permission",
                    mcpServers: [{ name: "marker", command: "fixture", args: [], env: [] }],
                },
                join(cwd, "receipt"),
            );
        } finally {
            if (path === undefined) delete process.env.PATH;
            else process.env.PATH = path;
            await removeExecutableFixtureDirectory(cwd);
        }
    });
}

test("ACP selects only allow_once for the approved tool and preserves text and usage", async () => {
    await withFixture(async (options, receipt) => {
        const result = await runAgyAcpTurn({
            ...options,
            authorizePermission: (call) =>
                call.name === "mcp_marker_complete" && call.arguments.toolSummary === "Marker",
        });
        assert.equal(await readFile(receipt, "utf8"), "once\n");
        assert.equal(result.text, "result");
        assert.equal(result.metadata.model, "gemini-3.8-flash");
        assert.equal(result.modelSelectionSource, "config_options");
        assert.equal(result.metadata.usage.thinkingTokens, 1);
    });
});

test("ACP denies unrelated permissions and does not accept end_turn as success", async () => {
    await withFixture(async (options, receipt) => {
        await assert.rejects(runAgyAcpTurn({ ...options, userRequest: "denied" }), {
            kind: "permission_denied",
        });
        await assert.rejects(readFile(receipt, "utf8"), { code: "ENOENT" });
        const failedUsage: (number | null)[] = [];
        await assert.rejects(
            runAgyAcpTurn(
                { ...options, userRequest: "failure" },
                {
                    onUsage: (usage) => failedUsage.push(usage.inputTokens),
                },
            ),
            { kind: "custom_agent_invalid" },
        );
        assert.deepEqual(failedUsage, [5]);
    });
});

test("ACP sends session/cancel before process cleanup", async () => {
    await withFixture(async (options, receipt) => {
        const ctrl = new AbortController();
        await assert.rejects(
            runAgyAcpTurn({ ...options, userRequest: "cancel", signal: ctrl.signal }, { onDelta: () => ctrl.abort() }),
            { kind: "canceled" },
        );
        assert.equal(await readFile(receipt, "utf8"), "cancel\n");
    });
});

test("ACP accepts cancellation as terminal only for a locally recorded completion", async () => {
    await withFixture(async (options, receipt) => {
        const terminal = new AbortController();
        const result = await runAgyAcpTurn(
            { ...options, userRequest: "terminal", terminalSignal: terminal.signal },
            { onDelta: () => terminal.abort() },
        );
        assert.equal(result.metadata.status, "success");
        assert.equal(await readFile(receipt, "utf8"), "cancel\n");
    });
});
