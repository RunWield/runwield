import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { createDelegateAgentTool, diffDelegatedChangeSnapshot, resolveDelegatedToolNames } from "../delegate-agent.ts";
import { loadSubAgentDefinition } from "../../shared/session/subagent-definitions.ts";
import { SUBAGENTS } from "../../constants.js";

/**
 * @typedef {Object} DelegateToolDetails
 * @property {boolean} ok
 * @property {"read" | "write"} mode
 * @property {string} [role]
 * @property {"read" | "write"} [requestedAuthority]
 * @property {"read" | "write"} [effectiveAuthority]
 * @property {"read" | "write"} [roleAuthorityCeiling]
 * @property {string[]} [validRoles]
 * @property {string[]} [tools]
 * @property {string[]} [changedPaths]
 * @property {boolean} [changeAttributionComplete]
 * @property {boolean} [committedChangesDetected]
 * @property {string} [error]
 */

/**
 * @typedef {Object} DelegateToolResult
 * @property {Array<{ type: string, text: string }>} content
 * @property {DelegateToolDetails} details
 * @property {boolean} [isError]
 */

/**
 * @typedef {Object} ExecutableTool
 * @property {(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, context: Record<string, unknown>) => Promise<DelegateToolResult>} execute
 */

/**
 * @param {unknown} tool
 * @param {Record<string, unknown>} params
 * @param {AbortSignal} [signal]
 * @returns {Promise<DelegateToolResult>}
 */
async function execute(tool, params, signal = new AbortController().signal) {
    const executable = /** @type {ExecutableTool} */ (tool);
    return await executable.execute("delegate-call", params, signal, () => {}, {});
}

/** @returns {Promise<import('@earendil-works/pi-agent-core').AgentMessage[]>} */
function assistantDone() {
    const message = /** @type {import('@earendil-works/pi-ai').AssistantMessage} */ ({
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
    });
    return Promise.resolve([message]);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
    const command = new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" });
    const output = await command.output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout);
}

async function makeDelegateGitRepo() {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-delegate-agent-" });
    await git(cwd, ["init", "-b", "main"]);
    await git(cwd, ["config", "user.email", "test@example.com"]);
    await git(cwd, ["config", "user.name", "RunWield Test"]);
    await Deno.mkdir(join(cwd, "src"), { recursive: true });
    await Deno.writeTextFile(join(cwd, "src", "pre-existing.js"), "before\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "initial"]);
    return cwd;
}

Deno.test("resolveDelegatedToolNames intersects parent tools with mode policy", () => {
    const parentTools = [
        "read",
        "bash",
        "edit",
        "create_image",
        "web_search",
        "web_fetch",
        "web_code_search",
        "web_docs_search",
        "write_docs",
        "edit_docs",
        "task_completed",
        "review_complete",
        "triage_report",
        "user_interview",
        "memory",
        "delegate_agent",
    ];

    assertEquals(resolveDelegatedToolNames(parentTools, "read"), [
        "read",
        "bash",
        "web_search",
        "web_fetch",
        "web_code_search",
        "web_docs_search",
    ]);
    assertEquals(resolveDelegatedToolNames(parentTools, "write"), [
        "read",
        "bash",
        "edit",
        "create_image",
        "web_search",
        "web_fetch",
        "web_code_search",
        "web_docs_search",
    ]);
});

Deno.test("diffDelegatedChangeSnapshot compares the full pre/post workspace baseline", () => {
    assertEquals(
        diffDelegatedChangeSnapshot(
            [
                { path: "src/deleted-untracked.js", status: "??", contentHash: "gone" },
                { path: "src/pre-existing.js", status: " M", contentHash: "same" },
                { path: "src/modified.js", status: " M", contentHash: "before" },
            ],
            [
                { path: "src/modified.js", status: " M", contentHash: "after" },
                { path: "src/new.js", status: "??", contentHash: "new" },
                { path: "src/pre-existing.js", status: " M", contentHash: "same" },
            ],
        ),
        ["src/deleted-untracked.js", "src/modified.js", "src/new.js"],
    );
});

Deno.test("diffDelegatedChangeSnapshot refuses attribution when HEAD changes", () => {
    assertEquals(
        diffDelegatedChangeSnapshot(
            { head: "before", entries: [] },
            { head: "after", entries: [] },
        ),
        null,
    );
});

Deno.test("delegated agent prompt includes inherited repository context placeholders", async () => {
    const promptPath = join(
        import.meta.dirname ?? Deno.cwd(),
        "..",
        "..",
        "..",
        "src",
        "agent-definitions",
        "subagent-definitions",
        "delegated-agent-prompt.md",
    );
    const prompt = await Deno.readTextFile(promptPath);
    const delegated = await loadSubAgentDefinition(SUBAGENTS.DELEGATED);
    const readDelegate = await loadSubAgentDefinition(SUBAGENTS.DELEGATED_READ);

    assertStringIncludes(delegated.systemPrompt, "{{GLOBAL_AGENTSMD}}");
    assertStringIncludes(delegated.systemPrompt, "{{PROJECT_AGENTSMD}}");
    assertStringIncludes(delegated.systemPrompt, "{{PROJECT_STATE_CONTEXT}}");
    assertStringIncludes(delegated.systemPrompt, "{{MEMORIES}}");
    assertStringIncludes(readDelegate.systemPrompt, "Treat core memories as strong guidance");
    assertStringIncludes(readDelegate.systemPrompt, "Leave all changes uncommitted");
    // The prompt must not declare `tools:` at all. barePrompt subagents take their
    // ceiling from the allowedTools registry entry, so a field here would be ignored
    // while reading as authoritative — this file once claimed `tools: []` while the
    // delegate actually received write access.
    assertEquals(/^tools:/m.test(prompt), false);
    assertEquals(delegated.tools.includes("write"), true);
    assertEquals(readDelegate.tools.includes("bash"), true);
    assertEquals(readDelegate.tools.includes("write"), false);
    assertEquals(delegated.tools.includes("web_search"), true);
    assertEquals(delegated.tools.includes("web_fetch"), true);
    assertEquals(delegated.tools.includes("web_code_search"), true);
    assertEquals(delegated.tools.includes("web_docs_search"), true);
});

Deno.test("delegate_agent returns child output without inheriting workflow tools", async () => {
    /** @type {Array<import('../delegate-agent.ts').DelegatedAgentSessionOptions>} */
    const calls = [];
    const hostedSession = new HostedSession({ id: "delegate-read", cwd: Deno.cwd() });
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: Deno.cwd(),
        parentTools: [
            "read",
            "web_search",
            "web_fetch",
            "web_docs_search",
            "bash",
            "task_completed",
            "delegate_agent",
        ],
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
    assertEquals(
        calls[0].userRequest,
        [
            "Delegation mode: read",
            "",
            "You are running as a context-isolated child. Complete only the brief below and return a concise handoff.",
            "",
            "## Brief",
            "Inspect src/foo.js",
        ].join("\n"),
    );
});

Deno.test("delegate_agent applies verification-adversary read-only role ceiling", async () => {
    /** @type {Array<import('../delegate-agent.ts').DelegatedAgentSessionOptions>} */
    const calls = [];
    const hostedSession = new HostedSession({ id: "delegate-adversary", cwd: Deno.cwd() });
    /** @type {Array<{ readers: number, writer: boolean }>} */
    const leaseStates = [];
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: Deno.cwd(),
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
    assertStringIncludes(String(calls[0].userRequest || ""), "Delegated role: verification-adversary");
    assertStringIncludes(String(calls[0].userRequest || ""), "so this session runs as read");
    // Session machinery receives a canonical registry selection, not a replaceable definition.
    assertEquals(calls[0].subAgentDefinition, {
        id: "delegated-read",
        options: { delegatedRole: "verification-adversary" },
    });
    assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

Deno.test("delegate_agent rejects an unknown role before a child session starts", async () => {
    let sessionStarts = 0;
    const hostedSession = new HostedSession({ id: "delegate-unknown-role", cwd: Deno.cwd() });
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: Deno.cwd(),
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

Deno.test("delegate_agent propagates parent model and thinking state", async () => {
    /** @type {Array<import('../delegate-agent.ts').DelegatedAgentSessionOptions>} */
    const calls = [];
    const hostedSession = new HostedSession({ id: "delegate-parent-state", cwd: Deno.cwd() });
    hostedSession.pushAgentInfo("Engineer", "anthropic/claude-sonnet-4", "anthropic", "engineer");
    hostedSession.setThinkingLevel("high");
    hostedSession.setProjectStateContext("Project state guidance");
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: Deno.cwd(),
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

Deno.test("delegate_agent preserves failed writer changes and releases lease", async () => {
    const executionCwd = await makeDelegateGitRepo();
    try {
        await Deno.writeTextFile(join(executionCwd, "src", "pre-existing.js"), "modified\n");
        const hostedSession = new HostedSession({ id: "delegate-write-fail", cwd: Deno.cwd() });
        /** @type {Array<import('../delegate-agent.ts').DelegatedAgentSessionOptions>} */
        const calls = [];
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: executionCwd,
            parentTools: ["read", "write", "bash"],
            runIsolatedAgentSession: async (opts) => {
                calls.push(opts);
                await Deno.writeTextFile(join(executionCwd, "src", "changed.js"), "new\n");
                return Promise.reject(new Error("boom"));
            },
        });

        const result = await execute(tool, { mode: "write", brief: "Change one file" });

        assertEquals(result.isError, true);
        assertEquals(result.details.ok, false);
        assertEquals(result.details.changedPaths, ["src/changed.js"]);
        assertEquals(result.details.changeAttributionComplete, true);
        assertEquals(calls[0].cwd, executionCwd);
        assertEquals(calls[0].toolNames, ["read", "write", "bash"]);
        assertEquals(hostedSession.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
    } finally {
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("delegate_agent flags writer attribution incomplete when HEAD changes", async () => {
    const executionCwd = await makeDelegateGitRepo();
    try {
        const hostedSession = new HostedSession({ id: "delegate-write-commit", cwd: Deno.cwd() });
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: executionCwd,
            parentTools: ["read", "write"],
            runIsolatedAgentSession: async () => {
                await Deno.writeTextFile(join(executionCwd, "src", "committed.js"), "new\n");
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
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("delegate_agent returns structured failure when lease acquisition is rejected", async () => {
    const hostedSession = new HostedSession({ id: "delegate-lease-conflict", cwd: Deno.cwd() });
    const release = hostedSession.acquireDelegatedAgentLease("write");
    try {
        const tool = createDelegateAgentTool({
            hostedSession,
            cwd: Deno.cwd(),
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

Deno.test("delegate_agent forwards cancellation and releases its lease", async () => {
    const hostedSession = new HostedSession({ id: "delegate-cancel", cwd: Deno.cwd() });
    const controller = new AbortController();
    /** @type {AbortSignal | undefined} */
    let childSignal;
    const tool = createDelegateAgentTool({
        hostedSession,
        cwd: Deno.cwd(),
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
