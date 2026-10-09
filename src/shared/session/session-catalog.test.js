import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
    assembleFinalSystemPrompt,
    expandPromptTemplate,
    expandSkillCommand,
    listLoadedAgentMdFiles,
    listPromptTemplates,
    listSkills,
    readGlobalAgentMd,
    steerActiveSessionWithTarget,
    steerRootSession,
    steerRootSessionWithTarget,
} from "./session.js";
import { ensureBundledAgentDefFile, getBundledAgentDefsPath } from "./agent-assets.ts";
import { HostedSession } from "./hosted-session.js";
import { getAgentDisplayName, listAvailableAgents } from "./agents.js";
import { getCustomSetting } from "../settings.js";
import { loadPlan } from "../../plan-store.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

Deno.test("two project roots keep local catalogs settings and Plans isolated", async () => {
    const alpha = await Deno.makeTempDir({ prefix: "runwield-project-alpha-" });
    const beta = await Deno.makeTempDir({ prefix: "runwield-project-beta-" });
    try {
        for (const [root, marker] of [[alpha, "alpha"], [beta, "beta"]]) {
            await Deno.mkdir(join(root, ".wld", "prompts"), { recursive: true });
            await Deno.mkdir(join(root, ".wld", "skills", "local-skill"), { recursive: true });
            await Deno.mkdir(join(root, ".wld", "agents"), { recursive: true });
            await Deno.mkdir(join(root, "docs", "plans"), { recursive: true });
            await Deno.writeTextFile(
                join(root, ".wld", "prompts", "local-prompt.md"),
                `---\ndescription: "${marker} prompt"\n---\n${marker} prompt body`,
            );
            await Deno.writeTextFile(
                join(root, ".wld", "skills", "local-skill", "SKILL.md"),
                `---\nname: "local-skill"\ndescription: "${marker} skill"\n---\n${marker} skill body`,
            );
            await Deno.writeTextFile(
                join(root, ".wld", "agents", "local-agent.md"),
                `---\nname: "${marker} Agent"\ndescription: "${marker}"\ntools: []\n---\n${marker} agent body`,
            );
            await Deno.writeTextFile(join(root, ".wld", "settings.json"), JSON.stringify({ marker }));
            await Deno.writeTextFile(
                join(root, "docs", "plans", "same-plan.md"),
                `---\nclassification: FEATURE\ncomplexity: LOW\nsummary: "${marker} plan"\naffectedPaths: []\nstatus: approved\n---\n# ${marker} plan`,
            );
        }

        const [alphaPrompts, betaPrompts, alphaSkills, betaSkills, alphaAgents, betaAgents] = await Promise.all([
            listPromptTemplates({ cwd: alpha }),
            listPromptTemplates({ cwd: beta }),
            listSkills({ cwd: alpha }),
            listSkills({ cwd: beta }),
            listAvailableAgents(alpha),
            listAvailableAgents(beta),
        ]);

        assertEquals(alphaPrompts.find((item) => item.name === "local-prompt")?.description, "alpha prompt");
        assertEquals(betaPrompts.find((item) => item.name === "local-prompt")?.description, "beta prompt");
        assertEquals(alphaSkills.find((item) => item.name === "local-skill")?.description, "alpha skill");
        assertEquals(betaSkills.find((item) => item.name === "local-skill")?.description, "beta skill");
        assertEquals(alphaAgents.some((item) => item.name === "local-agent"), true);
        assertEquals(betaAgents.some((item) => item.name === "local-agent"), true);
        assertEquals(getAgentDisplayName("local-agent", alpha), "alpha Agent");
        assertEquals(getAgentDisplayName("local-agent", beta), "beta Agent");
        assertEquals(getCustomSetting("marker", "project", alpha), "alpha");
        assertEquals(getCustomSetting("marker", "project", beta), "beta");
        assertEquals((await loadPlan(alpha, "same-plan"))?.attrs.summary, "alpha plan");
        assertEquals((await loadPlan(beta, "same-plan"))?.attrs.summary, "beta plan");
    } finally {
        await Deno.remove(alpha, { recursive: true });
        await Deno.remove(beta, { recursive: true });
    }
});

Deno.test("listPromptTemplates gives local templates precedence and parses metadata", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-prompts-" });
    const projectPromptsDir = join(projectRoot, ".wld", "prompts");
    await Deno.mkdir(projectPromptsDir, { recursive: true });
    try {
        await Deno.writeTextFile(
            join(projectPromptsDir, "code-review.md"),
            [
                "---",
                'description: "Local review override"',
                'argument-hint: "<diff>"',
                'model: "test/model"',
                'agent: "operator"',
                'thinkingLevel: "low"',
                "---",
                "Local body",
            ].join("\n"),
        );
        await Deno.writeTextFile(
            join(projectPromptsDir, "coverage-local.md"),
            "Describe local prompt from body.",
        );
        await Deno.writeTextFile(
            join(projectPromptsDir, "adversarial-tools.md"),
            [
                "---",
                'description: "Adversarial template"',
                "tools:",
                "  - bash",
                "  - user_interview",
                "  - task_completed",
                "---",
                "Template body.",
            ].join("\n"),
        );

        const templates = await listPromptTemplates({ cwd: projectRoot });
        const names = templates.map((template) => template.name);
        const codeReview = templates.find((template) => template.name === "code-review");
        const local = templates.find((template) => template.name === "coverage-local");
        const adversarial = templates.find((template) => template.name === "adversarial-tools");

        assertEquals(names.filter((name) => name === "code-review").length, 1);
        assertEquals(codeReview?.source, "local");
        assertEquals(codeReview?.description, "Local review override");
        assertEquals(codeReview?.argumentHint, "<diff>");
        assertEquals(codeReview?.model, "test/model");
        assertEquals(codeReview?.agent, "operator");
        assertEquals(codeReview?.thinkingLevel, "low");
        assertEquals(local?.description, "Describe local prompt from body.");
        assertEquals(Object.prototype.hasOwnProperty.call(adversarial || {}, "tools"), false);

        const testSeams = templates.find((template) => template.name === "test-seams");
        assert(testSeams);
        assertEquals(testSeams.source, "bundled");
        assertEquals(testSeams.agent, "engineer");
        const audit = await expandPromptTemplate(testSeams.path, "Focus on the payment tests.");
        assertStringIncludes(audit, "Possible test-seam risks");
        assertStringIncludes(audit, "write-tests");
        assertStringIncludes(audit, "When ownership is ambiguous");
        assertStringIncludes(audit, "Focus on the payment tests.");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("listPromptTemplates includes installed package prompts after RunWield prompts", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "runwield-package-prompts-" });
    const promptPath = join(tempDir, "explain.md");
    try {
        await Deno.writeTextFile(
            promptPath,
            [
                "---",
                'description: "Explain from package"',
                'argument-hint: "<topic>"',
                'model: "test/package-model"',
                "---",
                "Explain package prompt body.",
            ].join("\n"),
        );

        const templates = await listPromptTemplates({
            packagePromptResources: [{
                path: promptPath,
                enabled: true,
                metadata: {
                    source: "npm:@example/prompts",
                    scope: "user",
                    origin: "package",
                    baseDir: tempDir,
                },
            }],
        });
        const template = templates.find((item) => item.name === "explain");

        assertEquals(template?.source, "package");
        assertEquals(template?.description, "Explain from package");
        assertEquals(template?.argumentHint, "<topic>");
        assertEquals(template?.model, "test/package-model");
        assertEquals(template?.packageSource, "npm:@example/prompts");
        assertEquals(template?.packageBaseDir, tempDir);
    } finally {
        await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
});

Deno.test("expandPromptTemplate strips front matter and appends user instructions", async () => {
    const path = await Deno.makeTempFile({ prefix: "runwield-template-", suffix: ".md" });
    try {
        await Deno.writeTextFile(
            path,
            [
                "---",
                'description: "Template"',
                "---",
                "Template body",
                "",
            ].join("\n"),
        );

        assertEquals(await expandPromptTemplate(path, "Extra instructions"), "Template body\n\nExtra instructions");
        await assertRejects(
            () => expandPromptTemplate(`${path}.missing`),
            Error,
            "Failed to read prompt template",
        );
    } finally {
        await Deno.remove(path).catch(() => {});
    }
});

Deno.test("listSkills and expandSkillCommand read local skill definitions", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-local-skill-" });
    const skillName = `coverage-skill-${crypto.randomUUID()}`;
    const skillDir = join(projectRoot, ".wld", "skills", skillName);
    const skillPath = join(skillDir, "SKILL.md");
    await Deno.mkdir(skillDir, { recursive: true });
    try {
        await Deno.writeTextFile(
            skillPath,
            [
                "---",
                `name: "${skillName}"`,
                'description: "Exercise local skill loading"',
                "---",
                "Use this skill carefully.",
            ].join("\n"),
        );

        const skills = await listSkills({ cwd: projectRoot });
        const skill = skills.find((item) => item.name === skillName);
        assertEquals(skill?.source, "local");
        assertEquals(skill?.description, "Exercise local skill loading");

        const expanded = await expandSkillCommand(skillName, "User extra", projectRoot);
        assertStringIncludes(expanded, `The user has invoked the "${skillName}" skill.`);
        assertStringIncludes(expanded, `<skill name="${skillName}" location="${skillPath}">`);
        assertStringIncludes(expanded, "Use this skill carefully.");
        assertStringIncludes(expanded, "User extra");

        await assertRejects(
            () => expandSkillCommand("missing-skill"),
            Error,
            "Unknown skill: missing-skill",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("listSkills advertises bundled skills from the runtime-readable cache", async () => {
    await withProcessGlobalTestLock(async () => {
        const skills = await listSkills();
        const research = skills.find((item) => item.name === "research");

        assertEquals(research?.source, "bundled");
        const researchPath = research?.path ?? "";
        assertEquals(
            researchPath.includes(".wld/bundled-skills/research/SKILL.md") ||
                researchPath.includes("src/skills/research/SKILL.md"),
            true,
        );
    });
});

Deno.test("ensureBundledAgentDefFile resolves workflow prompt assets", async () => {
    const path = await ensureBundledAgentDefFile(join("subagent-definitions", "reviewer-prompt.md"));
    const prompt = await Deno.readTextFile(path);

    assertStringIncludes(path, "subagent-definitions");
    assertStringIncludes(prompt, "Workflow-only semantic review prompt");
});

Deno.test("bundled agent defs path and loaded instruction files are reported", async () => {
    const bundledPath = await getBundledAgentDefsPath();
    assertEquals(bundledPath.endsWith("agent-definitions") || bundledPath.includes("bundled-agent-definitions"), true);

    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-loaded-agent-md-" });
    const projectHarnessPath = join(projectRoot, "RUNWIELD.md");
    try {
        await Deno.writeTextFile(projectHarnessPath, "Project instructions for coverage");
        const files = await listLoadedAgentMdFiles(projectRoot);
        const projectFile = files.find((file) => file.path === projectHarnessPath);
        assertEquals(projectFile, { path: projectHarnessPath, source: "local" });
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("readGlobalAgentMd falls through configured global instruction paths", async () => {
    const home = await Deno.makeTempDir({ prefix: "runwield-global-agent-md-" });
    const wldDir = join(home, ".wld");
    const externalDir = join(home, ".agents");
    await Deno.mkdir(wldDir, { recursive: true });
    await Deno.mkdir(externalDir, { recursive: true });
    try {
        await Deno.writeTextFile(join(externalDir, "AGENTS.md"), "External instructions");
        assertEquals(await readGlobalAgentMd(home), "External instructions");

        await Deno.writeTextFile(join(wldDir, "AGENTS.md"), "Legacy RunWield instructions");
        assertEquals(await readGlobalAgentMd(home), "Legacy RunWield instructions");

        await Deno.writeTextFile(join(wldDir, "RUNWIELD.md"), "RunWield instructions");
        assertEquals(await readGlobalAgentMd(home), "RunWield instructions");
        assertEquals(await readGlobalAgentMd(home, { includeExternal: false }), "RunWield instructions");
    } finally {
        await Deno.remove(home, { recursive: true }).catch(() => {});
    }
});

Deno.test("assembleFinalSystemPrompt fills tools, instruction files, skills, and bundled paths", async () => {
    await withProcessGlobalTestLock(async () => {
        const tempHome = await Deno.makeTempDir({ prefix: "runwield-assemble-prompt-" });
        const projectRoot = await Deno.makeTempDir({ prefix: "runwield-assemble-project-" });
        const projectHarnessPath = join(projectRoot, "RUNWIELD.md");
        const skillName = `coverage-skill-${crypto.randomUUID()}`;
        const skillDir = join(projectRoot, ".wld", "skills", skillName);
        const skillPath = join(skillDir, "SKILL.md");

        try {
            await Deno.mkdir(join(tempHome, ".wld"), { recursive: true });
            await Deno.writeTextFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global prompt context");
            await Deno.writeTextFile(projectHarnessPath, "Project prompt context");
            await Deno.mkdir(skillDir, { recursive: true });
            await Deno.writeTextFile(
                skillPath,
                [
                    "---",
                    `name: "${skillName}"`,
                    'description: "Available for prompt assembly"',
                    "---",
                    "Use this skill carefully.",
                ].join("\n"),
            );

            const prompt = await assembleFinalSystemPrompt(
                /** @type {any} */ ({
                    systemPrompt: [
                        "Tools:",
                        "{{AVAILABLE_TOOLS}}",
                        "Global:",
                        "{{GLOBAL_AGENTSMD}}",
                        "Project:",
                        "{{PROJECT_AGENTSMD}}",
                        "Memories:",
                        "{{MEMORIES}}",
                        "Skills:",
                        "{{SKILLS}}",
                        "Bundled:",
                        "{{BUNDLED_AGENT_DEFS_DIR}}",
                    ].join("\n"),
                }),
                ["read", "custom_tool", "unknown_tool"],
                /** @type {any[]} */ ([{
                    name: "custom_tool",
                    description: "custom description",
                    promptSnippet: "custom snippet",
                }]),
                projectRoot,
                "",
                { homeDir: tempHome },
            );

            assertStringIncludes(prompt, "- read -");
            assertStringIncludes(prompt, "- custom_tool - custom snippet");
            assertStringIncludes(prompt, "- unknown_tool - Built-in tool");
            assertStringIncludes(prompt, "Global prompt context");
            assertStringIncludes(prompt, "Project prompt context");
            assertStringIncludes(prompt, `${skillName} - Available for prompt assembly (read: ${skillPath})`);
            assertStringIncludes(prompt, "agent-definitions");
        } finally {
            await Deno.remove(tempHome, { recursive: true }).catch(() => {});
            await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

Deno.test("steerRootSession sends image content only while root is streaming", async () => {
    /** @type {Array<{ text: string, images?: unknown[] }>} */
    const steerCalls = [];
    const session = /** @type {any} */ ({
        isStreaming: false,
        steer: (/** @type {string} */ text, /** @type {unknown[]} */ images) => {
            steerCalls.push({ text, images });
            return Promise.resolve();
        },
    });

    const hostedSession = new HostedSession({ id: "steer-catalog", cwd: Deno.cwd() });
    assertEquals(await steerRootSession(hostedSession, "queued"), false);

    hostedSession.setRootAgentSession(session);
    assertEquals(await steerRootSession(hostedSession, "queued"), false);
    assertEquals(steerCalls, []);

    session.isStreaming = true;
    assertEquals(
        await steerRootSession(hostedSession, "interrupt", [{ base64: "abc123", mimeType: "image/png" }]),
        true,
    );
    assertEquals(steerCalls, [{
        text: "interrupt",
        images: [{ type: "image", data: "abc123", mimeType: "image/png" }],
    }]);
    assertEquals(await steerRootSessionWithTarget(hostedSession, "targeted"), session);
});

Deno.test("steerActiveSessionWithTarget prefers streaming foreground target and keeps root helper root-only", async () => {
    const calls = /** @type {string[]} */ ([]);
    const root = /** @type {any} */ ({
        isStreaming: true,
        model: { input: ["text"] },
        steer(/** @type {string} */ text) {
            calls.push(`root:${text}`);
            return Promise.resolve();
        },
    });
    const foreground = /** @type {any} */ ({
        isStreaming: true,
        model: { input: ["text"] },
        steer(/** @type {string} */ text) {
            calls.push(`foreground:${text}`);
            return Promise.resolve();
        },
    });
    const hostedSession = new HostedSession({ id: "active-steer-catalog", cwd: Deno.cwd() });
    hostedSession.setRootAgentSession(root);
    const targetId = hostedSession.pushSteeringTargetSession(foreground);

    assertEquals(await steerActiveSessionWithTarget(hostedSession, "active"), foreground);
    assertEquals(await steerRootSessionWithTarget(hostedSession, "root"), root);
    assertEquals(calls, ["foreground:active", "root:root"]);

    foreground.isStreaming = false;
    assertEquals(await steerActiveSessionWithTarget(hostedSession, "fallback"), root);
    assertEquals(calls.at(-1), "root:fallback");
    hostedSession.popSteeringTargetSession(targetId);
});
