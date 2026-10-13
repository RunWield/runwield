import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createPayload, resolveNamedInvocation } from "./named-invocation.ts";
import { HostedSession } from "./hosted-session.js";
import { ensureRootAgentSession, runRootTurn } from "./session.js";
import { setCustomSetting } from "../settings.js";

async function writePrompt(projectRoot: string, name: string, frontMatter: string[], body: string): Promise<void> {
    const promptDir = join(projectRoot, ".wld", "prompts");
    await fsMkdir(promptDir, { recursive: true });
    await fsWriteFile(join(promptDir, `${name}.md`), ["---", ...frontMatter, "---", body].join("\n"));
}

async function writeSkill(projectRoot: string, name: string): Promise<void> {
    const skillDir = join(projectRoot, ".wld", "skills", name);
    await fsMkdir(skillDir, { recursive: true });
    await fsWriteFile(
        join(skillDir, "SKILL.md"),
        ["---", `name: "${name}"`, "description: fixture skill", "---", "Use the fixture skill body."].join("\n"),
    );
}

test("resolveNamedInvocation resolves Prompt Template Front Matter and exact expansion", async () => {
    await withRuntimeCommandFixture("named-invocation-resolve-template-", async ({ projectRoot }) => {
        await writePrompt(
            projectRoot,
            "summarize",
            ["agent: operator", "model: runtime-command-fixture/fixture-model"],
            "Summarize: {{input}}",
        );

        const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: "/summarize the active diff" });

        assertEquals(resolved.kind, "prompt_template");
        if (resolved.kind !== "prompt_template") return;
        assertEquals(resolved.name, "summarize");
        assertEquals(resolved.agentName, "operator");
        assertEquals(resolved.model, "runtime-command-fixture/fixture-model");
        assertEquals(resolved.expandedRequest, "Summarize: {{input}}\n\nthe active diff");
        const payload = resolved.payload;
        assertEquals(payload.compactInvocation, "/summarize the active diff");
        assertEquals(payload.expandedRequest, "Summarize: {{input}}\n\nthe active diff");
        assertEquals(payload.profile.agentName, "operator");
    });
});

test("resolveNamedInvocation preserves an omitted Agent for runtime Session defaults", async () => {
    await withRuntimeCommandFixture("named-invocation-default-agent-", async ({ projectRoot }) => {
        await writePrompt(projectRoot, "commit-message", [], "Write a commit message for {{input}}");

        const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: "/commit-message staged files" });

        assertEquals(resolved.kind, "prompt_template");
        if (resolved.kind !== "prompt_template") return;
        assertEquals(resolved.agentName, undefined);
    });
});

test("resolveNamedInvocation resolves Skills without changing the Agent profile", async () => {
    await withRuntimeCommandFixture("named-invocation-resolve-skill-", async ({ projectRoot }) => {
        await writeSkill(projectRoot, "diagnose-fixture");

        const resolved = await resolveNamedInvocation({
            cwd: projectRoot,
            text: "/skill:diagnose-fixture inspect logs",
        });

        assertEquals(resolved.kind, "skill");
        if (resolved.kind !== "skill") return;
        assertEquals(resolved.name, "diagnose-fixture");
        assertStringIncludes(resolved.expandedRequest, 'The user has invoked the "diagnose-fixture" skill.');
        assertStringIncludes(resolved.expandedRequest, "Use the fixture skill body.");
        assertStringIncludes(resolved.expandedRequest, "inspect logs");
        assertEquals(resolved.payload.profile, {});
    });
});

test("resolveNamedInvocation rejects invalid Prompt Template execution Front Matter clearly", async () => {
    await withRuntimeCommandFixture("named-invocation-invalid-profile-", async ({ projectRoot }) => {
        await writePrompt(projectRoot, "bad-agent", ["agent: definitely-not-an-agent"], "Bad agent.");
        await writePrompt(projectRoot, "bad-model", ["model: fixture-model"], "Bad model.");
        await writePrompt(projectRoot, "bad-thinking", ["thinkingLevel: maximum"], "Bad thinking.");
        await writePrompt(projectRoot, "blank-agent", ['agent: ""'], "Blank agent.");
        await writePrompt(projectRoot, "null-model", ["model:"], "Null model.");

        await assertRejects(
            () => resolveNamedInvocation({ cwd: projectRoot, text: "/bad-agent" }),
            Error,
            'Prompt template "bad-agent" declares unknown agent',
        );
        await assertRejects(
            () => resolveNamedInvocation({ cwd: projectRoot, text: "/bad-model" }),
            Error,
            'Prompt template "bad-model" declares invalid model',
        );
        await assertRejects(
            () => resolveNamedInvocation({ cwd: projectRoot, text: "/bad-thinking" }),
            Error,
            'Prompt template "bad-thinking" declares invalid thinkingLevel',
        );
        await assertRejects(
            () => resolveNamedInvocation({ cwd: projectRoot, text: "/blank-agent" }),
            Error,
            'Prompt template "blank-agent" declares blank agent',
        );
        await assertRejects(
            () => resolveNamedInvocation({ cwd: projectRoot, text: "/null-model" }),
            Error,
            'Prompt template "null-model" declares non-string model',
        );
    });
});

test("resolveNamedInvocation does not resolve Prompt Template names outside resource layers", async () => {
    await withRuntimeCommandFixture("named-invocation-template-traversal-", async ({ projectRoot }) => {
        await fsMkdir(join(projectRoot, ".wld"), { recursive: true });
        await fsWriteFile(join(projectRoot, ".wld", "secret.md"), "Secret outside prompt layers.");

        const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: "/../secret" });

        assertEquals(resolved.kind, "ordinary");
    });
});

test("resolveNamedInvocation obeys disabled external Skill discovery", async () => {
    await withRuntimeCommandFixture("named-invocation-external-skill-disabled-", async ({ projectRoot, homeDir }) => {
        const skillDir = join(homeDir, ".agents", "skills", "external-fixture");
        await fsMkdir(skillDir, { recursive: true });
        await fsWriteFile(
            join(skillDir, "SKILL.md"),
            ["---", "name: external-fixture", "description: external fixture", "---", "External body."].join("\n"),
        );
        await setCustomSetting("enableExternalSkills", false, "global", projectRoot);

        const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:external-fixture" });

        assertEquals(resolved.kind, "ordinary");
    });
});

test("legacy Named Invocation repair preserves branch edits and omits summarized entries", async () => {
    await withRuntimeCommandFixture("named-invocation-pi-repair-rules-", async ({ projectRoot }) => {
        const payload = await createPayload({
            kind: "prompt_template",
            compactInvocation: "/legacy saved request",
            expandedRequest: "Expanded legacy request",
            images: [{ base64: "aW1hZ2U=", mimeType: "image/png", ref: "legacy-image.png" }],
            source: { layer: "local", name: "legacy" },
            profile: { agentName: "operator" },
        });
        const manager = SessionManager.inMemory(projectRoot);

        const replacementMetadataId = manager.appendCustomEntry("runwield.named_invocation", payload);
        const replacementTargetId = manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "/legacy saved request" }],
            timestamp: Date.now(),
        });
        manager.appendContextEdit(replacementTargetId, {
            content: [{ type: "text", text: "Existing replacement wins" }],
        });

        manager.appendCustomEntry("runwield.named_invocation", payload);
        const omittedTargetId = manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "/legacy saved request" }],
            timestamp: Date.now(),
        });
        manager.appendContextEdit(omittedTargetId, null);

        const siblingMetadataId = manager.appendCustomEntry("runwield.named_invocation", payload);
        const siblingTargetId = manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "/legacy saved request" }],
            timestamp: Date.now(),
        });
        manager.appendContextEdit(siblingTargetId, {
            content: [{ type: "text", text: "Sibling-only replacement" }],
        });
        manager.branch(siblingMetadataId);
        const activeSiblingTargetId = manager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "/legacy saved request" }],
            timestamp: Date.now(),
        });

        const hosted = new HostedSession({
            id: "named-invocation-pi-repair-rules",
            cwd: projectRoot,
            sessionManager: manager as never,
        });
        try {
            await ensureRootAgentSession({ hostedSession: hosted, agentName: "operator" });
        } finally {
            hosted.dispose();
        }

        const allEntries = manager.getEntries();
        assertEquals(
            allEntries.filter((entry) => entry.type === "context_edit" && entry.targetId === replacementTargetId)
                .length,
            1,
        );
        assertEquals(
            allEntries.filter((entry) => entry.type === "context_edit" && entry.targetId === omittedTargetId).length,
            1,
        );
        assertEquals(
            allEntries.filter((entry) => entry.type === "context_edit" && entry.targetId === activeSiblingTargetId)
                .length,
            1,
        );
        const activeContext = JSON.stringify(manager.buildSessionContext().messages);
        assertStringIncludes(activeContext, "Existing replacement wins");
        assertStringIncludes(activeContext, "Expanded legacy request");
        assertStringIncludes(activeContext, "[Image attached: legacy-image.png image/png]");
        assertEquals(activeContext.includes("Sibling-only replacement"), false);
        assertEquals(activeContext.includes(`\"id\":\"${replacementMetadataId}\"`), false);

        const compactedManager = SessionManager.inMemory(projectRoot);
        compactedManager.appendCustomEntry("runwield.named_invocation", payload);
        const summarizedTargetId = compactedManager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "/legacy saved request" }],
            timestamp: Date.now(),
        });
        compactedManager.appendMessage(fauxAssistantMessage(fauxText("old answer")));
        const retainedId = compactedManager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "retained request" }],
            timestamp: Date.now(),
        });
        compactedManager.appendCompaction("Summary without the old invocation", retainedId, 100, {}, false, undefined);
        const compactedHosted = new HostedSession({
            id: "named-invocation-pi-repair-summarized",
            cwd: projectRoot,
            sessionManager: compactedManager as never,
        });
        try {
            await ensureRootAgentSession({ hostedSession: compactedHosted, agentName: "operator" });
        } finally {
            compactedHosted.dispose();
        }
        assertEquals(
            compactedManager.getEntries().some((entry) =>
                entry.type === "context_edit" && entry.targetId === summarizedTargetId
            ),
            false,
        );
    });
});

test("Prompt Template expansion is restored for kept pre-compaction Pi entries", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-pi-restore-kept-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const manager = SessionManager.inMemory(projectRoot);
            const payload = await createPayload({
                kind: "prompt_template",
                compactInvocation: "/kept-template saved request",
                expandedRequest: "Expanded kept request",
                images: [],
                source: { layer: "local", name: "kept-template" },
                profile: { agentName: "operator" },
            });
            manager.appendCustomEntry("runwield.named_invocation", payload);
            const userEntryId = manager.appendMessage({
                role: "user",
                content: [{ type: "text", text: "/kept-template saved request" }],
                timestamp: Date.now(),
            });
            manager.appendMessage(fauxAssistantMessage(fauxText("The compact request was answered.")));
            manager.appendCompaction("Earlier history summary", userEntryId, 100, {}, false, undefined);
            for (let index = 0; index < 4; index += 1) {
                manager.appendMessage({
                    role: "user",
                    content: [{ type: "text", text: `later request ${index} ${"x".repeat(20_000)}` }],
                    timestamp: Date.now(),
                });
                manager.appendMessage(fauxAssistantMessage(fauxText(`later answer ${index} ${"y".repeat(20_000)}`)));
            }

            const modelRequests: string[] = [];
            setModelResponseFactories([
                (context: TranscriptContext) => {
                    modelRequests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("Compaction summary: Expanded kept request"));
                },
                (context: TranscriptContext) => {
                    modelRequests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("resumed answer"));
                },
            ]);
            const firstActivation = new HostedSession({
                id: "named-invocation-pi-restore-kept-first",
                cwd: projectRoot,
                sessionManager: manager as never,
            });
            await ensureRootAgentSession({ hostedSession: firstActivation, agentName: "operator" });
            firstActivation.dispose();
            assertEquals(
                manager.getBranch().filter((entry) => entry.type === "context_edit" && entry.targetId === userEntryId)
                    .length,
                1,
            );

            const resumed = new HostedSession({
                id: "named-invocation-pi-restore-kept-resumed",
                cwd: projectRoot,
                sessionManager: manager as never,
            });
            try {
                const session = await ensureRootAgentSession({ hostedSession: resumed, agentName: "operator" });
                await session.compact("Preserve the exact kept request.");
                await runRootTurn({ hostedSession: resumed, agentName: "operator", userRequest: "continue" });
            } finally {
                resumed.dispose();
            }

            const branch = manager.getBranch();
            assertEquals(
                branch.filter((entry) => entry.type === "context_edit" && entry.targetId === userEntryId).length,
                1,
            );
            const savedUser = branch.find((entry) => entry.id === userEntryId);
            assertEquals(
                savedUser?.type === "message" && savedUser.message.role === "user" ? savedUser.message.content : null,
                [
                    { type: "text", text: "/kept-template saved request" },
                ],
            );
            assertEquals(modelRequests.length, 2);
            for (const modelRequest of modelRequests) {
                assertStringIncludes(modelRequest, "Expanded kept request");
                assertEquals(modelRequest.includes("/kept-template saved request"), false);
            }
        },
    );
});
