import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { getCwd } from "../../constants.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { createDelegateAgentTool } from "../delegate-agent.ts";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { DelegateAgentDetails, DelegatedAgentSessionOptions, DelegationMode } from "../delegate-agent.ts";

type DelegateTool = ReturnType<typeof createDelegateAgentTool>;
interface DelegateToolResult extends Omit<AgentToolResult<DelegateAgentDetails>, "content"> {
    content: TextContent[];
    isError?: boolean;
}
type DelegatedLeaseState = ReturnType<HostedSession["getDelegatedAgentLeaseState"]>;

// The invalid-role case deliberately exercises the tool's runtime validation boundary.
interface DelegateTestParameters {
    mode: DelegationMode;
    role?: string;
    brief: string;
}

async function execute(
    tool: DelegateTool,
    params: DelegateTestParameters,
    signal = new AbortController().signal,
): Promise<DelegateToolResult> {
    const executable = tool;
    // These fixtures use no context fields and assert the tool's text-only results.
    return (await executable.execute(
        "delegate-call",
        params,
        signal,
        () => {},
        {} as ExtensionToolContext,
    )) as DelegateToolResult;
}

function assistantDone(): Promise<AgentMessage[]> {
    const message: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: "test",
        model: "test",
        content: [{ type: "text", text: "done" }],
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
    return Promise.resolve([message]);
}

async function git(cwd: string, args: string[]) {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout);
}

async function makeDelegateGitRepo() {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-delegate-agent-"));
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.email", "test@example.com"]);
    await git(cwd, ["config", "user.name", "RunWield Test"]);
    await fsMkdir(join(cwd, "src"), { recursive: true });
    await fsWriteFile(join(cwd, "src", "pre-existing.js"), "before\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "initial"]);
    return cwd;
}

test("delegate_agent returns child output without inheriting workflow tools", async () => {
    const calls: DelegatedAgentSessionOptions[] = [];
    const hostedSession = new HostedSession({ id: "delegate-read", cwd: getCwd() });
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: ["read", "web_search", "web_fetch", "web_docs_search", "bash", "task_completed", "delegate_agent"],
        runIsolatedAgentSession: (opts) => {
            calls.push(opts);
            return assistantDone();
        },
    });

    const result = await execute(tool, { mode: "read", brief: "Inspect src/foo.js" });

    assertEquals(result.details.ok, true);
    assertEquals(result.details.tools, ["read", "web_search", "web_fetch", "web_docs_search", "bash"]);
    assertEquals(result.content[0].text, "done");
    assertEquals(calls[0].toolNames, ["read", "web_search", "web_fetch", "web_docs_search", "bash"]);
    assertStringIncludes(String(calls[0].userRequest || ""), "Inspect src/foo.js");
    // Omitting role resolves to the unspecialized default and changes nothing about the request.
    assertEquals(result.details.role, "general");
    assertEquals(result.details.requestedAuthority, "read");
    assertEquals(result.details.effectiveAuthority, "read");
    assertEquals(calls[0].userRequest, ["Delegation mode: read", "", "## Brief", "Inspect src/foo.js"].join("\n"));
});

test("delegate_agent applies verification-adversary read-only role ceiling", async () => {
    const calls: DelegatedAgentSessionOptions[] = [];
    const hostedSession = new HostedSession({ id: "delegate-adversary", cwd: getCwd() });
    const leaseStates: DelegatedLeaseState[] = [];
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: [
            "read",
            "grep",
            "web_search",
            "web_fetch",
            "web_docs_search",
            "bash",
            "edit",
            "write",
            "multi_file_edit",
            "delegate_agent",
        ],
        runIsolatedAgentSession: (opts) => {
            calls.push(opts);
            leaseStates.push(hostedSession.getDelegatedAgentLeaseState());
            return assistantDone();
        },
    });

    const result = await execute(tool, {
        mode: "write",
        role: "verification-adversary",
        brief: "Attack the draft Plan below.",
    });

    // The role ceiling wins over the requested mode: read lease, read tools, no write machinery.
    assertEquals(leaseStates[0], { readers: 1, writer: false });
    assertEquals(calls[0].toolNames, ["read", "grep", "web_search", "web_fetch", "web_docs_search", "bash"]);
    assertEquals(calls[0].includeEditFallback, false);
    assertEquals(result.details.changedPaths, undefined);
    assertEquals(result.details.changeAttributionComplete, undefined);
    assertEquals(result.details.committedChangesDetected, undefined);
    // The parent can see the downgrade it did not ask for.
    assertEquals(result.details.ok, true);
    assertEquals(result.details.role, "verification-adversary");
    assertEquals(result.details.requestedAuthority, "write");
    assertEquals(result.details.effectiveAuthority, "read");
    assertEquals(result.details.roleAuthorityCeiling, "read");
    assertEquals(result.details.mode, "read");
    assertEquals(calls[0].userRequest, "Delegation mode: read\n\n## Brief\nAttack the draft Plan below.");
    // Session machinery receives a canonical registry selection, not a replaceable definition.
    assertEquals(calls[0].subAgentDefinition, {
        id: "delegated-read",
        options: { delegatedRole: "verification-adversary" },
    });
    assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

test("delegate_agent rejects an unknown role before a child session starts", async () => {
    let sessionStarts = 0;
    const hostedSession = new HostedSession({ id: "delegate-unknown-role", cwd: getCwd() });
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: ["read"],
        runIsolatedAgentSession: () => {
            sessionStarts += 1;
            return assistantDone();
        },
    });

    const result = await execute(tool, { mode: "read", role: "researcher", brief: "Investigate" });

    assertEquals(sessionStarts, 0);
    assertEquals(result.isError, true);
    assertEquals(result.details.ok, false);
    assertEquals(result.details.error, "unknown_role");
    assertEquals(result.details.validRoles, ["general", "verification-adversary"]);
    assertStringIncludes(result.content[0].text, "verification-adversary");
    assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

test("delegate_agent limited to read mode advertises and accepts only read", async () => {
    let sessionStarts = 0;
    const hostedSession = new HostedSession({ id: "delegate-read-only", cwd: getCwd() });
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: ["read", "edit"],
        delegationModes: ["read"],
        runIsolatedAgentSession: () => {
            sessionStarts += 1;
            return assistantDone();
        },
    });

    assertEquals(tool.parameters.properties.mode.enum, ["read"]);
    assertStringIncludes(tool.description, "Only mode 'read'");

    const denied = await execute(tool, { mode: "write", brief: "Implement" });
    assertEquals(sessionStarts, 0);
    assertEquals(denied.isError, true);
    assertEquals(denied.details.error, "delegation_mode_denied");
    assertStringIncludes(denied.content[0].text, "Allowed: read");

    const allowed = await execute(tool, { mode: "read", brief: "Investigate" });
    assertEquals(allowed.details.ok, true);
    assertEquals(sessionStarts, 1);
    assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

test("delegate_agent limited to write mode refuses a role that reduces it to read", async () => {
    let sessionStarts = 0;
    const tool = createDelegateAgentTool({
        hostedSession: new HostedSession({ id: "delegate-write-only", cwd: getCwd() }),
        cwd: getCwd(),
        parentTools: ["read", "edit"],
        delegationModes: ["write"],
        runIsolatedAgentSession: () => {
            sessionStarts += 1;
            return assistantDone();
        },
    });

    assertEquals(tool.parameters.properties.mode.enum, ["write"]);
    assertEquals(tool.description.includes("background"), false);
    const denied = await execute(tool, { mode: "write", role: "verification-adversary", brief: "Attack" });
    assertEquals(sessionStarts, 0);
    assertEquals(denied.details.error, "delegation_mode_denied");
});

test("delegate_agent propagates parent model and thinking state", async () => {
    const calls: DelegatedAgentSessionOptions[] = [];
    const hostedSession = new HostedSession({ id: "delegate-parent-state", cwd: getCwd() });
    hostedSession.pushAgentInfo("Engineer", "anthropic/claude-sonnet-4", "anthropic", "engineer");
    hostedSession.setThinkingLevel("high");
    hostedSession.setProjectStateContext("Project state guidance");
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: ["read"],
        runIsolatedAgentSession: (opts) => {
            calls.push(opts);
            return assistantDone();
        },
    });

    await execute(tool, { mode: "read", brief: "Inspect state" });

    assertEquals(calls[0].modelOverride, "anthropic/claude-sonnet-4");
    assertEquals(calls[0].thinkingLevelOverride, "high");
    assertEquals(calls[0].projectStateContext, "Project state guidance");
});

test("delegate_agent preserves failed writer changes and releases lease", async () => {
    const executionCwd = await makeDelegateGitRepo();
    try {
        await fsWriteFile(join(executionCwd, "src", "pre-existing.js"), "modified\n");
        await fsWriteFile(join(executionCwd, "src", "deleted-untracked.js"), "gone\n");
        await fsWriteFile(join(executionCwd, "src", "modified.js"), "before\n");
        const hostedSession = new HostedSession({ id: "delegate-write-fail", cwd: executionCwd });
        const calls: DelegatedAgentSessionOptions[] = [];
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: executionCwd,
            parentTools: ["read", "write", "bash"],
            runIsolatedAgentSession: async (opts) => {
                calls.push(opts);
                await fsWriteFile(join(executionCwd, "src", "changed.js"), "new\n");
                await fsWriteFile(join(executionCwd, "src", "modified.js"), "after\n");
                await fsRm(join(executionCwd, "src", "deleted-untracked.js"));
                return Promise.reject(new Error("boom"));
            },
        });

        const result = await execute(tool, { mode: "write", brief: "Change one file" });

        assertEquals(result.isError, true);
        assertEquals(result.details.ok, false);
        assertEquals(result.details.changedPaths, ["src/changed.js", "src/deleted-untracked.js", "src/modified.js"]);
        assertEquals(await fsReadFile(join(executionCwd, "src", "pre-existing.js"), "utf8"), "modified\n");
        assertEquals(await fsReadFile(join(executionCwd, "src", "changed.js"), "utf8"), "new\n");
        assertEquals(result.details.changeAttributionComplete, true);
        assertEquals(calls[0].cwd, executionCwd);
        assertEquals(calls[0].toolNames, ["read", "write", "bash"]);
        assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
    } finally {
        await fsRm(executionCwd, { recursive: true });
    }
});

test("delegate_agent flags writer attribution incomplete when HEAD changes", async () => {
    const executionCwd = await makeDelegateGitRepo();
    try {
        const hostedSession = new HostedSession({ id: "delegate-write-commit", cwd: getCwd() });
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: executionCwd,
            parentTools: ["read", "write"],
            runIsolatedAgentSession: async () => {
                await fsWriteFile(join(executionCwd, "src", "committed.js"), "new\n");
                await git(executionCwd, ["add", "."]);
                await git(executionCwd, ["commit", "-m", "delegate change"]);
                return assistantDone();
            },
        });

        const result = await execute(tool, { mode: "write", brief: "Change one file" });

        assertEquals(result.details.ok, true);
        assertEquals(result.details.changedPaths, null);
        assertEquals(result.details.changeAttributionComplete, false);
        assertEquals(result.details.committedChangesDetected, true);
    } finally {
        await fsRm(executionCwd, { recursive: true });
    }
});

test("delegate_agent returns structured failure when lease acquisition is rejected", async () => {
    const hostedSession = new HostedSession({ id: "delegate-lease-conflict", cwd: getCwd() });
    const release = hostedSession.acquireDelegatedAgentLease("write");
    try {
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: getCwd(),
            parentTools: ["read"],
            runIsolatedAgentSession: () => assistantDone(),
        });

        const result = await execute(tool, { mode: "read", brief: "Inspect while writer runs" });

        assertEquals(result.isError, true);
        assertEquals(result.details.ok, false);
        assertEquals(result.details.mode, "read");
        assertStringIncludes(result.details.error || "", "writer is already running");
    } finally {
        release();
    }
});

test("delegate_agent forwards cancellation and releases its lease", async () => {
    const hostedSession = new HostedSession({ id: "delegate-cancel", cwd: getCwd() });
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: getCwd(),
        parentTools: ["read"],
        runIsolatedAgentSession: (opts) => {
            childSignal = opts.signal;
            return new Promise((_resolve, reject) => {
                opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
            });
        },
    });

    const pending = execute(tool, { mode: "read", brief: "Inspect until canceled" }, controller.signal);
    while (!childSignal) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("cancelled"));
    const result = await pending;

    assertEquals(childSignal.aborted, true);
    assertEquals(result.isError, true);
    assertEquals(result.details.ok, false);
    assertStringIncludes(result.details.error || "", "cancelled");
    assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});
