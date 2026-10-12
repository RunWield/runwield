import { makeTempFile } from "../../testing/temp-file.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
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

test("two project roots keep local catalogs settings and Plans isolated", async () => {
    const alpha = await fsMkdtemp(join(tmpdir(), "runwield-project-alpha-"));
    const beta = await fsMkdtemp(join(tmpdir(), "runwield-project-beta-"));
    try {
        for (const [root, marker] of [
            [alpha, "alpha"],
            [beta, "beta"],
        ]) {
            await fsMkdir(join(root, ".wld", "prompts"), { recursive: true });
            await fsMkdir(join(root, ".wld", "skills", "local-skill"), { recursive: true });
            await fsMkdir(join(root, ".wld", "agents"), { recursive: true });
            await fsMkdir(join(root, "docs", "plans"), { recursive: true });
            await fsWriteFile(
                join(root, ".wld", "prompts", "local-prompt.md"),
                `---\ndescription: "${marker} prompt"\n---\n${marker} prompt body`,
            );
            await fsWriteFile(
                join(root, ".wld", "skills", "local-skill", "SKILL.md"),
                `---\nname: "local-skill"\ndescription: "${marker} skill"\n---\n${marker} skill body`,
            );
            await fsWriteFile(
                join(root, ".wld", "agents", "local-agent.md"),
                `---\nname: "${marker} Agent"\ndescription: "${marker}"\ntools: []\n---\n${marker} agent body`,
            );
            await fsWriteFile(join(root, ".wld", "settings.json"), JSON.stringify({ marker }));
            await fsWriteFile(
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
        assertEquals(
            alphaAgents.some((item) => item.name === "local-agent"),
            true,
        );
        assertEquals(
            betaAgents.some((item) => item.name === "local-agent"),
            true,
        );
        assertEquals(getAgentDisplayName("local-agent", alpha), "alpha Agent");
        assertEquals(getAgentDisplayName("local-agent", beta), "beta Agent");
        assertEquals(getCustomSetting("marker", "project", alpha), "alpha");
        assertEquals(getCustomSetting("marker", "project", beta), "beta");
        assertEquals((await loadPlan(alpha, "same-plan"))?.attrs.summary, "alpha plan");
        assertEquals((await loadPlan(beta, "same-plan"))?.attrs.summary, "beta plan");
    } finally {
        await fsRm(alpha, { recursive: true });
        await fsRm(beta, { recursive: true });
    }
});

test("listPromptTemplates gives local templates precedence and parses metadata", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-prompts-"));
    const projectPromptsDir = join(projectRoot, ".wld", "prompts");
    await fsMkdir(projectPromptsDir, { recursive: true });
    try {
        await fsWriteFile(
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
        await fsWriteFile(join(projectPromptsDir, "coverage-local.md"), "Describe local prompt from body.");
        await fsWriteFile(
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
        await fsRm(projectRoot, { recursive: true });
    }
});

test("listPromptTemplates includes installed package prompts after RunWield prompts", async () => {
    const tempDir = await fsMkdtemp(join(tmpdir(), "runwield-package-prompts-"));
    const promptPath = join(tempDir, "explain.md");
    try {
        await fsWriteFile(
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
            packagePromptResources: [
                {
                    path: promptPath,
                    enabled: true,
                    metadata: {
                        source: "npm:@example/prompts",
                        scope: "user",
                        origin: "package",
                        baseDir: tempDir,
                    },
                },
            ],
        });
        const template = templates.find((item) => item.name === "explain");

        assertEquals(template?.source, "package");
        assertEquals(template?.description, "Explain from package");
        assertEquals(template?.argumentHint, "<topic>");
        assertEquals(template?.model, "test/package-model");
        assertEquals(template?.packageSource, "npm:@example/prompts");
        assertEquals(template?.packageBaseDir, tempDir);
    } finally {
        await fsRm(tempDir, { recursive: true }).catch(() => {});
    }
});

test("expandPromptTemplate strips front matter and appends user instructions", async () => {
    const path = await makeTempFile({ prefix: "runwield-template-", suffix: ".md" });
    try {
        await fsWriteFile(path, ["---", 'description: "Template"', "---", "Template body", ""].join("\n"));

        assertEquals(await expandPromptTemplate(path, "Extra instructions"), "Template body\n\nExtra instructions");
        await assertRejects(() => expandPromptTemplate(`${path}.missing`), Error, "Failed to read prompt template");
    } finally {
        await fsRm(path).catch(() => {});
    }
});

test("listSkills and expandSkillCommand read local skill definitions", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-local-skill-"));
    const skillName = `coverage-skill-${crypto.randomUUID()}`;
    const skillDir = join(projectRoot, ".wld", "skills", skillName);
    const skillPath = join(skillDir, "SKILL.md");
    await fsMkdir(skillDir, { recursive: true });
    try {
        await fsWriteFile(
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

        await assertRejects(() => expandSkillCommand("missing-skill"), Error, "Unknown skill: missing-skill");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("listSkills advertises bundled skills from the runtime-readable cache", async () => {
    await withProcessGlobalTestLock(async () => {
        const skills = await listSkills();
        const research = skills.find((item) => item.name === "research");

        assertEquals(research?.source, "bundled");
        const researchPath = research?.path ?? "";
        assertEquals(
            researchPath.includes(join(".wld", "bundled-skills", "research", "SKILL.md")) ||
                researchPath.includes(join("src", "skills", "research", "SKILL.md")),
            true,
        );
    });
});

test("ensureBundledAgentDefFile resolves workflow prompt assets", async () => {
    const path = await ensureBundledAgentDefFile(join("subagent-definitions", "reviewer-prompt.md"));
    const prompt = await fsReadFile(path, "utf8");

    assertStringIncludes(path, "subagent-definitions");
    assertStringIncludes(prompt, "Workflow-only semantic review prompt");
});

test("bundled agent defs path and loaded instruction files are reported", async () => {
    const bundledPath = await getBundledAgentDefsPath();
    assertEquals(bundledPath.endsWith("agent-definitions") || bundledPath.includes("bundled-agent-definitions"), true);

    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-loaded-agent-md-"));
    const projectHarnessPath = join(projectRoot, "RUNWIELD.md");
    try {
        await fsWriteFile(projectHarnessPath, "Project instructions for coverage");
        const files = await listLoadedAgentMdFiles(projectRoot);
        const projectFile = files.find((file) => file.path === projectHarnessPath);
        assertEquals(projectFile, { path: projectHarnessPath, source: "local" });
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("readGlobalAgentMd falls through configured global instruction paths", async () => {
    const home = await fsMkdtemp(join(tmpdir(), "runwield-global-agent-md-"));
    const wldDir = join(home, ".wld");
    const externalDir = join(home, ".agents");
    await fsMkdir(wldDir, { recursive: true });
    await fsMkdir(externalDir, { recursive: true });
    try {
        await fsWriteFile(join(externalDir, "AGENTS.md"), "External instructions");
        assertEquals(await readGlobalAgentMd(home), "External instructions");

        await fsWriteFile(join(wldDir, "AGENTS.md"), "Legacy RunWield instructions");
        assertEquals(await readGlobalAgentMd(home), "Legacy RunWield instructions");

        await fsWriteFile(join(wldDir, "RUNWIELD.md"), "RunWield instructions");
        assertEquals(await readGlobalAgentMd(home), "RunWield instructions");
        assertEquals(await readGlobalAgentMd(home, { includeExternal: false }), "RunWield instructions");
    } finally {
        await fsRm(home, { recursive: true }).catch(() => {});
    }
});

test("assembleFinalSystemPrompt fills tools, instruction files, skills, and bundled paths", async () => {
    await withProcessGlobalTestLock(async () => {
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-assemble-prompt-"));
        const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-assemble-project-"));
        const projectHarnessPath = join(projectRoot, "RUNWIELD.md");
        const skillName = `coverage-skill-${crypto.randomUUID()}`;
        const skillDir = join(projectRoot, ".wld", "skills", skillName);
        const skillPath = join(skillDir, "SKILL.md");

        try {
            await fsMkdir(join(tempHome, ".wld"), { recursive: true });
            await fsWriteFile(join(tempHome, ".wld", "RUNWIELD.md"), "Global prompt context");
            await fsWriteFile(projectHarnessPath, "Project prompt context");
            await fsMkdir(skillDir, { recursive: true });
            await fsWriteFile(
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
                /** @type {any[]} */ ([
                    {
                        name: "custom_tool",
                        description: "custom description",
                        promptSnippet: "custom snippet",
                    },
                ]),
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
            await fsRm(tempHome, { recursive: true }).catch(() => {});
            await fsRm(projectRoot, { recursive: true }).catch(() => {});
        }
    });
});

test("steerRootSession sends image content only while root is streaming", async () => {
    /** @type {Array<{ text: string, images?: unknown[] }>} */
    const steerCalls = [];
    const session = /** @type {any} */ ({
        isStreaming: false,
        steer: (/** @type {string} */ text, /** @type {unknown[]} */ images) => {
            steerCalls.push({ text, images });
            return Promise.resolve();
        },
    });

    const hostedSession = new HostedSession({ id: "steer-catalog", cwd: getCwd() });
    assertEquals(await steerRootSession(hostedSession, "queued"), false);

    hostedSession.setRootAgentSession(session);
    assertEquals(await steerRootSession(hostedSession, "queued"), false);
    assertEquals(steerCalls, []);

    session.isStreaming = true;
    assertEquals(
        await steerRootSession(hostedSession, "interrupt", [{ base64: "abc123", mimeType: "image/png" }]),
        true,
    );
    assertEquals(steerCalls, [
        {
            text: "interrupt",
            images: [{ type: "image", data: "abc123", mimeType: "image/png" }],
        },
    ]);
    assertEquals(await steerRootSessionWithTarget(hostedSession, "targeted"), session);
});

test("steerActiveSessionWithTarget prefers streaming foreground target and keeps root helper root-only", async () => {
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
    const hostedSession = new HostedSession({ id: "active-steer-catalog", cwd: getCwd() });
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
