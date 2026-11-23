import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { projects, ProjectIdentityEntryRequired } from "@runwield/projects";
import { test } from "node:test";
import { assertEquals, assertArrayIncludes } from "../../testing/assertions.ts";
import { match as assertMatch } from "node:assert/strict";
import { join } from "node:path";
import mnemotecaExtension from "./index.ts";
import type {
    ExtensionContext,
    ExtensionToolContext,
    SessionStartEvent,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolEntry, MemoryParams } from "@runwield/tools";
import type { HelperBinaryExec, HelperBinaryExecOptions, HelperBinaryExecResult } from "../helper-binary-exec.ts";

type FixtureExec = (...args: Parameters<HelperBinaryExec>) => HelperBinaryExecResult | Promise<HelperBinaryExecResult>;
type RegisteredHandler = (...args: never[]) => void;
type SessionStartHandler = (event: SessionStartEvent, context: ExtensionContext) => void | Promise<void>;
type FixtureToolContext = Partial<ExtensionToolContext>;

interface ExecCall {
    command: string;
    args: string[];
    opts: HelperBinaryExecOptions;
}

interface FixtureToolResult extends AgentToolResult<MemoryParams> {
    callMessage?: string;
}

type FixtureToolExecutor = (
    id: string,
    params: MemoryParams,
    signal: AbortSignal,
    onUpdate: () => void,
    context: FixtureToolContext,
) => Promise<FixtureToolResult>;

interface RegisteredTool extends Omit<
    ToolDefinition<ToolEntry<"memory">["definition"]["parameters"], MemoryParams>,
    "execute"
> {
    execute: FixtureToolExecutor;
}

interface FixtureExtensionAPI {
    on(event: "session_start", handler: SessionStartHandler): void;
    registerTool(tool: RegisteredTool): void;
    exec: HelperBinaryExec;
}

type FixtureExtensionRegistration = (host: FixtureExtensionAPI) => void;

let projectRoot: string;
let projectId: string;

async function admit(root: string): Promise<string> {
    const result = await projects.checkout.admit(root);
    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
    return result.identity.projectId;
}

test.before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mnemoteca-extension-"));
    projectId = await admit(projectRoot);
});

test.after(async () => {
    await rm(projectRoot, { recursive: true });
});

function setup(execImpl: FixtureExec) {
    const handlers = new Map<string, RegisteredHandler>();
    const tools: RegisteredTool[] = [];
    const calls: ExecCall[] = [];

    const pi: FixtureExtensionAPI = {
        on(event: "session_start", handler: SessionStartHandler) {
            handlers.set(event, handler);
        },
        registerTool(tool: RegisteredTool) {
            tools.push(tool);
        },
        async exec(command: string, args: string[], opts: HelperBinaryExecOptions) {
            calls.push({ command, args, opts });
            return await execImpl(command, args, opts);
        },
    };

    (mnemotecaExtension as FixtureExtensionRegistration)(pi);

    const startSession = (cwd: string) => {
        const handler = handlers.get("session_start") as SessionStartHandler | undefined;
        if (!handler) throw new Error("session_start handler was not registered");
        handler({ type: "session_start" } as SessionStartEvent, { cwd } as ExtensionContext);
    };
    startSession(projectRoot);

    const getTool = (name: string) => {
        const tool = tools.find((registeredTool) => registeredTool.name === name);
        if (!tool) throw new Error(`Tool not found in test setup: ${name}`);
        return tool;
    };

    return { tools, calls, getTool, startSession };
}

async function executeTool(tool: RegisteredTool, params: MemoryParams) {
    const execute = tool.execute;
    return await execute("tool-call-1", params, new AbortController().signal, () => {}, {});
}

function firstText(result: Pick<FixtureToolResult, "content">) {
    const first = result.content[0];
    assertEquals(first?.type, "text");
    if (!first || first.type !== "text") throw new Error("Expected text content.");
    return first.text ?? "";
}

test("memory recall searches both scopes and escapes quotes", async () => {
    const { getTool, calls } = setup((_command, args) => {
        if (args[0] === "init") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        if (args.includes("--global")) return Promise.resolve({ code: 0, stdout: "global hit", stderr: "" });
        return Promise.resolve({ code: 0, stdout: "  found memory  \n", stderr: "" });
    });
    const tool = getTool("memory");

    const params: MemoryParams = { action: "recall", query: 'he said "hello"' };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(
        firstText(result),
        `Project memories (${projectId}) — these take precedence over global memories:\nfound memory\n\nGlobal memories (cross-project defaults):\nglobal hit`,
    );
    assertArrayIncludes(
        calls.map((call) => call.args.join(" ")),
        [
            ["search", "--name", projectId, "--format", "plain", '"he said ""hello"""'].join(" "),
            ["search", "--global", "--format", "plain", '"he said ""hello"""'].join(" "),
        ],
    );
});

test("memory recall returns one missing binary message when mnemoteca is unavailable", async () => {
    const { getTool } = setup(() => Promise.resolve({ code: 127, stdout: "", stderr: "" }));
    const tool = getTool("memory");

    const result = await executeTool(tool, { action: "recall", query: "test" });

    assertMatch(firstText(result), /mnemoteca binary not found/i);
    assertMatch(firstText(result), /RunWield installer/i);
    assertEquals(firstText(result).match(/mnemoteca binary not found/gi)?.length, 1);
});

test("memory stores project memory with optional core tag", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "stored", stderr: "" }));
    const tool = getTool("memory");

    const params: MemoryParams = { action: "store", content: "Use deno task ci", core: true };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "stored");
    assertEquals(result.callMessage, "Storing project memory:\n\nUse deno task ci");
    assertEquals(calls.at(-1)?.args, ["add", "--name", projectId, "--tag", "core", "Use deno task ci"]);
});

test("memory initializes global storage then adds memory", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "ok", stderr: "" }));
    const tool = getTool("memory");

    const params: MemoryParams = {
        action: "store",
        scope: "global",
        content: "Prefer concise commit messages",
        core: true,
    };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "ok");
    assertEquals(result.callMessage, "Storing global memory:\n\nPrefer concise commit messages");
    assertEquals(calls[0]?.args, ["init", "--global"]);
    assertEquals(calls[1]?.args, ["add", "--global", "--tag", "core", "Prefer concise commit messages"]);
});

test("memory delete checks the requested scope before deleting by id", async () => {
    const { getTool, calls } = setup((_command, args) => {
        if (args[0] === "init") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        if (args[0] === "export") {
            const global = args.includes("--global");
            writeFileSync(
                args[args.indexOf("--output") + 1],
                JSON.stringify({
                    version: 1,
                    collection: global ? "global" : args[args.indexOf("--name") + 1],
                    doc_count: 1,
                }) +
                    "\n" +
                    JSON.stringify({ original_document_id: global ? 42 : 7 }) +
                    "\n",
            );
            return Promise.resolve({ code: 0, stdout: "Exported", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "   ", stderr: "" });
    });
    const tool = getTool("memory");

    const params: MemoryParams = { action: "delete", id: 42, scope: "global" };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "Memory deleted.");
    assertEquals(calls.at(-1)?.args, ["delete", "42"]);
});

test("memory switches collections when session startup changes the working directory", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "mnemoteca-extension-other-"));
    try {
        const otherId = await admit(otherRoot);
        const { calls, getTool, startSession } = setup(() => ({ code: 0, stdout: "", stderr: "" }));
        const tool = getTool("memory");
        await executeTool(tool, { action: "store", content: "First Project" });
        startSession(otherRoot);
        await executeTool(tool, { action: "store", content: "Second Project" });
        assertEquals(
            calls.map(({ opts, args }) => [opts.cwd, args.slice(0, 3)]),
            [
                [projectRoot, ["init", "--name", projectId]],
                [projectRoot, ["add", "--name", projectId]],
                [otherRoot, ["init", "--name", otherId]],
                [otherRoot, ["add", "--name", otherId]],
            ],
        );
    } finally {
        await rm(otherRoot, { recursive: true });
    }
});
