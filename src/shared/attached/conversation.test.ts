import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests } from "../settings.ts";
import { git } from "../git-test-fixture.ts";
import { runAttachedOperation, type AttachedCarrierResult } from "./coordinator.ts";
import type { AttachedJsonObject, AttachedConversationalRole, AttachedOperationName } from "./operations.ts";
import { locateAttachedWorkflows } from "./record-store.ts";
import {
    CLI_PATH,
    EVIDENCE,
    activateInput,
    pendingTriage,
    readRecordBytes,
    runOperation,
    spawnAttachedCli,
    submitReview,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";

async function withHome(body: (root: string, home: string) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = await mkdtemp(join(tmpdir(), "connect-conversation-home-"));
        const previous = process.env.HOME;
        process.env.HOME = home;
        __resetSettingsForTests();
        try {
            await withProject((root) => body(root, home));
        } finally {
            if (previous === undefined) delete process.env.HOME;
            else process.env.HOME = previous;
            __resetSettingsForTests();
            await rm(home, { recursive: true, force: true });
        }
    });
}

async function writeRoles(root: string, roles: AttachedJsonObject) {
    await mkdir(join(root, ".wld"), { recursive: true });
    await writeFile(join(root, ".wld/settings.json"), JSON.stringify({ connect: { codex: { roles } } }));
}

async function readRole(root: string, role: AttachedConversationalRole, host = "codex") {
    return await runAttachedOperation(
        "get_role_instructions",
        root,
        JSON.stringify({
            role,
            evidence: {
                ...EVIDENCE,
                host,
                hostVersion: host === "codex" ? "0.164.0-alpha.11.1" : EVIDENCE.hostVersion,
            },
        }),
    );
}

function assertRole(result: AttachedCarrierResult, role: AttachedConversationalRole) {
    assert(result.ok && result.operation === "get_role_instructions" && result.instructions);
    assert.equal(result.workflow, undefined);
    assert.equal(result.instructions.role, role);
    assert.equal(result.instructions.contractVersion, "runwield.attached.conversation/1");
    const text = result.instructions.text;
    assert(text.includes(role === "guide" ? "You are the Guide" : "You are the Ideator"));
    assert(text.includes(role === "guide" ? "compact citations" : "The Socratic Interview Protocol"));
    assert(text.includes("The user has final authority"));
    assert(text.includes("## Skills"));
    assert(text.includes("Connect conversation — overrides"));
    assert(text.includes("loaded document formats"));
    assert(text.includes("Do not call artifact_written"));
    assert(text.includes("ordinary Markdown preservation"));
    assert(text.includes("preserve their status and notices"));
    assert(text.includes("Start planning only after an explicit user request"));
    assert(!text.includes("## RunWield in"));
    assert(!text.includes("operationId"));
    assert(!text.includes("{{"));
}

for (const host of ["claude-code", "codex"] as const) {
    for (const role of ["ideator", "guide"] as const) {
        test(`${host} MCP supports routed and direct ${role} with no conversation authority`, async () => {
            await withHome(async (root) => {
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    args: runtimeSourceArgs([
                        "run",
                        CLI_PATH,
                        "attached",
                        "mcp",
                        ...(host === "codex" ? ["codex"] : []),
                    ]),
                    cwd: root,
                    env: Object.fromEntries(
                        Object.entries(process.env).filter(
                            (entry): entry is [string, string] => entry[1] !== undefined,
                        ),
                    ),
                    stderr: "pipe",
                });
                const client = new Client({
                    name: host === "codex" ? "codex-mcp-client" : "claude-code",
                    version: host === "codex" ? "0.164.0-alpha.11.1" : EVIDENCE.hostVersion,
                });
                async function call(
                    name: AttachedOperationName,
                    input: AttachedJsonObject,
                ): Promise<AttachedCarrierResult> {
                    const { evidence: _evidence, ...args } = input;
                    const response = await client.callTool({ name, arguments: args });
                    return JSON.parse(JSON.stringify(response.structuredContent));
                }
                try {
                    await client.connect(transport);
                    const tools = await client.listTools();
                    const schema = tools.tools.find((tool) => tool.name === "get_role_instructions")?.inputSchema;
                    assert(schema);
                    assert.deepEqual(schema.required, ["role"]);
                    assert.equal(schema.additionalProperties, false);
                    assert.equal("evidence" in schema.properties!, false);
                    assertRole(await call("get_role_instructions", { role }), role);
                    assert.equal(
                        await readdir(locateAttachedWorkflows(root).workflowsDir).catch((error) => {
                            if (error.code === "ENOENT") return null;
                            throw error;
                        }),
                        null,
                    );
                    assert.equal(await git(root, ["status", "--porcelain", "--ignored"]), "");

                    const activated = await call("activate", activateInput());
                    assert(activated.ok && activated.workflow?.nextAction.kind === "triage");
                    const ids = {
                        workflowId: activated.workflow.workflowId,
                        actionId: activated.workflow.nextAction.actionId,
                    };
                    const input = triageReportInput({
                        ...ids,
                        outcome: {
                            routingIntent: role === "guide" ? "INQUIRY" : "IDEATION",
                            complexity: "LOW",
                            summary: "Discuss the requested topic",
                        },
                    });
                    const handed = await call("triage_report", input);
                    assert(handed.ok && handed.workflow);
                    assert.equal(handed.workflow.state, "closed");
                    assert.equal(handed.workflow.plan, null);
                    assert.deepEqual(handed.workflow.nextAction, {
                        kind: "role_handoff",
                        role,
                        actionId: null,
                        round: null,
                        chatPending: false,
                    });
                    assert.equal(handed.instructions, undefined);
                    const bytes = await readRecordBytes(root, ids.workflowId);
                    const record = JSON.parse(bytes);
                    assert.equal(record.pendingAction, null);
                    assert.deepEqual(record.closure, {
                        reason: "role_handoff",
                        routingIntent: role === "guide" ? "INQUIRY" : "IDEATION",
                        role,
                    });
                    assertRole(await call("get_role_instructions", { role }), role);
                    assert.deepEqual(await call("triage_report", input), handed);
                    assert.equal(await readRecordBytes(root, ids.workflowId), bytes);
                    for (const forbidden of [
                        '"instructions"',
                        '"dispatch"',
                        '"messages"',
                        '"history"',
                        "The Socratic Interview Protocol",
                    ])
                        assert.equal(bytes.includes(forbidden), false, forbidden);
                    assert.equal(
                        (await readdir(locateAttachedWorkflows(root).workflowsDir)).filter((name) =>
                            name.endsWith(".json"),
                        ).length,
                        1,
                    );
                    assert.equal(await git(root, ["status", "--porcelain", "--ignored"]), "");
                    const stale = await call("triage_report", { ...input, operationId: "new-stale-op" });
                    assert(!stale.ok);
                    assert.equal(stale.rejection.code, "revision_conflict");
                    const oldAction = await call("get_instructions", ids);
                    assert(!oldAction.ok);
                    assert.equal(oldAction.rejection.code, "action_superseded");
                    const status = await call("status", { workflowId: ids.workflowId });
                    assert(status.ok && status.workflow);
                    assert.equal(status.workflow.nextAction.kind, "role_handoff");
                } finally {
                    await client.close().catch(() => undefined);
                    await transport.close().catch(() => undefined);
                }
            });
        });
    }
}

test("stateless CLI and live layered Agent, shared practice, and Skill reads stay fresh", async () => {
    await withHome(async (root, home) => {
        for (const role of ["guide", "ideator"] as const) {
            const cli = await spawnAttachedCli("get_role_instructions", root, { role, evidence: EVIDENCE });
            assert.equal(cli.code, 0, cli.stderr);
            assertRole(cli.result, role);
            assert(cli.result.ok && cli.result.operation === "get_role_instructions" && cli.result.instructions);
            assert.equal(cli.result.instructions.dispatch, undefined);
            const homeAgents = join(home, ".wld/agents");
            const projectAgents = join(root, ".wld/agents");
            const skill = join(root, ".wld/skills/connect-evidence/SKILL.md");
            await mkdir(homeAgents, { recursive: true });
            await mkdir(projectAgents, { recursive: true });
            await mkdir(join(root, ".wld/skills/connect-evidence"), { recursive: true });
            await writeFile(join(homeAgents, `${role}.md`), `---\npromptOverride: true\n---\nHome ${role} evidence\n`);
            const personal = await readRole(root, role);
            assert(personal.ok);
            assert(personal.instructions.text.includes(`Home ${role} evidence`));
            for (const marker of ["first", "replacement"]) {
                await writeFile(
                    join(projectAgents, `${role}.md`),
                    `---\npromptOverride: true\n---\nProject ${role} ${marker}\n`,
                );
                await writeFile(
                    skill,
                    `---\nname: connect-evidence\ndescription: ${marker} evidence skill\n---\nEvidence\n`,
                );
                const current = await readRole(root, role);
                assert(current.ok);
                assert(current.instructions.text.includes(`Project ${role} ${marker}`));
                assert(!current.instructions.text.includes(`Home ${role} evidence`));
                assert(current.instructions.text.includes(`${marker} evidence skill (read: ${skill})`));
                assert(current.instructions.text.includes("The user has final authority"));
            }
        }
        assert.equal(
            await readdir(locateAttachedWorkflows(root).workflowsDir).catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
            }),
            null,
        );
    });
});

test("conversation handoffs and direct reads preserve an older open delivery and a bound Plan", async () => {
    await withHome(async (root) => {
        const older = await submitReview(root);
        const olderBytes = await readRecordBytes(root, older.workflowId);
        const planPath = join(root, "docs/plans/dark-mode-toggle.md");
        const planBytes = await readFile(planPath, "utf8");
        for (const role of ["guide", "ideator"] as const) {
            const activated = await runOperation("activate", root, {
                ...activateInput(`conversation-${role}`),
                payload: {
                    requestText: "Discuss this Plan",
                    hostRequestId: `host-${role}`,
                    existingPlan: { ...older.plan! },
                },
            });
            const ids = pendingTriage(activated);
            const handoff = await runOperation(
                "triage_report",
                root,
                triageReportInput({
                    ...ids,
                    outcome: {
                        routingIntent: role === "guide" ? "INQUIRY" : "IDEATION",
                        complexity: "LOW",
                        summary: "Discuss",
                    },
                }),
            );
            assert(handoff.ok);
            assert.deepEqual(handoff.workflow.plan, older.plan);
            const closedBytes = await readRecordBytes(root, ids.workflowId);
            assertRole(await readRole(root, role), role);
            assert.equal(await readRecordBytes(root, ids.workflowId), closedBytes);
            const status = await runOperation("status", root, {});
            assert(status.ok);
            assert.equal(status.workflow.workflowId, older.workflowId);
            assert.deepEqual(status.workflow.nextAction, older.nextAction);
            assert.equal(status.workflow.revision, older.revision);
            assert.equal(await readRecordBytes(root, older.workflowId), olderBytes);
            assert.equal(await readFile(planPath, "utf8"), planBytes);
        }
    });
});

test("stateless role settings use per-field scopes and refresh without freezing handoff receipts", async () => {
    await withHome(async (root, home) => {
        for (const role of ["ideator", "guide"] as const) {
            const ids = pendingTriage(await runOperation("activate", root, activateInput(`settings-${role}`)));
            const input = triageReportInput({
                ...ids,
                outcome: {
                    routingIntent: role === "guide" ? "INQUIRY" : "IDEATION",
                    complexity: "LOW",
                    summary: "Discuss",
                },
            });
            const handed = await runOperation("triage_report", root, input);
            const bytes = await readRecordBytes(root, ids.workflowId);
            await writeRoles(home, { [role]: { model: "personal-native", thinkingLevel: "high" } });
            for (const [fields, model, thinkingLevel] of [
                [{ thinkingLevel: "max" }, "personal-native", "max"],
                [{ model: "inherit" }, "inherit", "high"],
                [{ thinkingLevel: "inherit" }, "personal-native", "inherit"],
            ] as const) {
                await writeRoles(root, { [role]: fields });
                const result = await readRole(root, role);
                assert(result.ok);
                assert.deepEqual(result.instructions.dispatch, {
                    host: "codex",
                    role,
                    status: "ready",
                    model,
                    thinkingLevel,
                });
                const claude = await readRole(root, role, "claude-code");
                assert(claude.ok);
                assert.equal(claude.instructions.dispatch, undefined);
                assert.deepEqual(await runOperation("triage_report", root, input), handed);
                assert.equal(await readRecordBytes(root, ids.workflowId), bytes);
            }
            await writeRoles(root, { [role]: { model: "" } });
            const invalid = await readRole(root, role);
            assert(invalid.ok && invalid.instructions.dispatch?.status === "invalid");
            assert(
                invalid.instructions.dispatch.diagnostics.some((text) =>
                    text.includes(`connect.codex.roles.${role}.model`),
                ),
            );
        }
    });
});

test("invalid stateless calls are inert with and without existing work", async () => {
    await withHome(async (root) => {
        for (const existing of [false, true]) {
            if (existing) await runOperation("activate", root, activateInput());
            const location = locateAttachedWorkflows(root);
            const files = await readdir(location.workflowsDir).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            const before = await Promise.all(files.map((name) => readFile(join(location.workflowsDir, name), "utf8")));
            const inputs = [
                { role: "planner", evidence: EVIDENCE },
                { role: "guide", evidence: { ...EVIDENCE, host: "opencode" } },
                { role: "guide", evidence: { ...EVIDENCE, adapterContract: 0 } },
                { role: "guide", evidence: { ...EVIDENCE, hostVersion: "1.0.0" } },
                ...["requestText", "history", "messages", "workflowId", "actionId", "operationId", "payload"].map(
                    (key) => ({ role: "guide", evidence: EVIDENCE, [key]: "private sentinel" }),
                ),
            ];
            for (const input of inputs) {
                const result = await runAttachedOperation("get_role_instructions", root, JSON.stringify(input));
                assert(!result.ok, JSON.stringify(input));
                assert.equal(result.workflow, undefined);
            }
            for (const input of ["{", "null", "[]", "{}"]) {
                assert.equal((await runAttachedOperation("get_role_instructions", root, input)).ok, false);
            }
            assert.deepEqual(
                await readdir(location.workflowsDir).catch((error) => {
                    if (error.code === "ENOENT") return [];
                    throw error;
                }),
                files,
            );
            assert.deepEqual(
                await Promise.all(files.map((name) => readFile(join(location.workflowsDir, name), "utf8"))),
                before,
            );
            assert.equal(await git(root, ["status", "--porcelain", "--ignored"]), "");
        }
    });
});

for (const host of ["claude-code", "codex"] as const) {
    test(`${host} stateless MCP rejects spoofed host evidence and malformed role calls without writes`, async () => {
        await withHome(async (root) => {
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: runtimeSourceArgs(["run", CLI_PATH, "attached", "mcp", ...(host === "codex" ? ["codex"] : [])]),
                cwd: root,
                env: Object.fromEntries(
                    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
                stderr: "pipe",
            });
            const client = new Client({ name: "unrelated-client", version: EVIDENCE.hostVersion });
            try {
                await client.connect(transport);
                for (const args of [
                    { role: "guide", evidence: EVIDENCE },
                    { role: "engineer" },
                    { role: "guide", history: ["private later turn"] },
                    { role: "ideator", requestText: "private request" },
                ]) {
                    const response = await client.callTool({ name: "get_role_instructions", arguments: args });
                    const result: AttachedCarrierResult = JSON.parse(JSON.stringify(response.structuredContent));
                    assert(!result.ok);
                    assert.equal(response.isError, true);
                    assert.equal(result.workflow, undefined);
                    if (args.evidence) assert.equal(result.rejection.code, "unsupported_host");
                }
                assert.equal(
                    await readdir(locateAttachedWorkflows(root).workflowsDir).catch((error) => {
                        if (error.code === "ENOENT") return null;
                        throw error;
                    }),
                    null,
                );
                assert.equal(await git(root, ["status", "--porcelain", "--ignored"]), "");
            } finally {
                await client.close().catch(() => undefined);
                await transport.close().catch(() => undefined);
            }
        });
    });
}
