import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { createSessionRuntime } from "./session-runtime.ts";
import { buildAgentSession, expandSkillCommand, listSkills } from "./session.js";
import { resolveNamedInvocation } from "./named-invocation.ts";

async function writeSkill(
    root: string,
    relativeLayer: string,
    directoryName: string,
    name: string,
    marker: string,
): Promise<string> {
    const directory = join(root, relativeLayer, directoryName);
    const path = join(directory, "SKILL.md");
    await Deno.mkdir(directory, { recursive: true });
    await Deno.writeTextFile(
        path,
        ["---", `name: "${name}"`, `description: "${marker} description"`, "---", `${marker} body`].join("\n"),
    );
    return path;
}

function count(text: string, value: string): number {
    return text.split(value).length - 1;
}

async function assertPublicSelection(
    projectRoot: string,
    name: string,
    expectedPath: string,
    expectedSource: "local" | "home" | "bundled" | "external",
    marker: string,
): Promise<void> {
    const listed = (await listSkills({ cwd: projectRoot })).filter((skill) => skill.name === name);
    assertEquals(listed.length, 1);
    assertEquals(listed[0].path, expectedPath);
    assertEquals(listed[0].source, expectedSource);

    const expanded = await expandSkillCommand(name, "extra instruction", projectRoot);
    assertStringIncludes(expanded, `${marker} body`);
    assertStringIncludes(expanded, `location="${expectedPath}"`);
    assertStringIncludes(expanded, "extra instruction");

    const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: `/skill:${name} named extra` });
    assertEquals(resolved.kind, "skill");
    if (resolved.kind !== "skill") return;
    assertStringIncludes(resolved.expandedRequest, `${marker} body`);
    assertStringIncludes(resolved.expandedRequest, `location="${expectedPath}"`);
    assertEquals(resolved.payload.source.layer, expectedSource);
}

Deno.test("installed review skill is user-invokable with its portable instructions and support files", async () => {
    await withRuntimeCommandFixture("skill-catalog-review-", async ({ projectRoot }) => {
        const review = (await listSkills({ cwd: projectRoot })).find((skill) => skill.name === "review");
        assertEquals(review?.source, "bundled");
        const resolved = await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:review review PR 42" });
        assertEquals(resolved.kind, "skill");
        if (resolved.kind !== "skill" || !review) return;
        assertStringIncludes(resolved.expandedRequest, "review PR 42");
        assertStringIncludes(resolved.expandedRequest, "## Standards");
        assertStringIncludes(resolved.expandedRequest, "## Spec");
        assertStringIncludes(resolved.expandedRequest, "## Tests");

        const bundledDir = dirname(review.path);
        for (const file of ["SKILL.md", "github.md", "gitlab.md", "pull-requests.md"]) {
            assertEquals(
                await Deno.readTextFile(join(bundledDir, file)),
                (await Deno.readTextFile(fromFileUrl(new URL(`../../../skills/review/${file}`, import.meta.url))))
                    .replace("license: MIT; complete terms in ../LICENSE", "license: MIT; complete terms in LICENSE"),
            );
        }
        assertEquals(
            await Deno.readTextFile(join(bundledDir, "LICENSE")),
            await Deno.readTextFile(fromFileUrl(new URL("../../../skills/LICENSE", import.meta.url))),
        );
    });
});

Deno.test("Skill catalog applies all four custom layers in order and refreshes after winner removal", async () => {
    await withRuntimeCommandFixture("skill-catalog-layers-", async ({ projectRoot, homeDir }) => {
        const name = "layered-fixture";
        const layers = [
            {
                root: projectRoot,
                relative: join(".wld", "skills"),
                source: "local" as const,
                marker: "project wld",
            },
            {
                root: projectRoot,
                relative: join(".agents", "skills"),
                source: "external" as const,
                marker: "project agents",
            },
            {
                root: homeDir,
                relative: join(".wld", "skills"),
                source: "home" as const,
                marker: "home wld",
            },
            {
                root: homeDir,
                relative: join(".agents", "skills"),
                source: "external" as const,
                marker: "home agents",
            },
        ];
        const paths: string[] = [];
        for (const layer of layers) {
            paths.push(await writeSkill(layer.root, layer.relative, name, name, layer.marker));
        }

        for (let index = 0; index < layers.length; index++) {
            const layer = layers[index];
            await assertPublicSelection(projectRoot, name, paths[index], layer.source, layer.marker);
            await Deno.remove(join(layer.root, layer.relative, name), { recursive: true });
        }
        await assertRejects(() => expandSkillCommand(name, undefined, projectRoot), Error, `Unknown skill: ${name}`);

        const malformedDirectory = join(projectRoot, ".wld", "skills", "readable-fallback");
        await Deno.mkdir(malformedDirectory, { recursive: true });
        await Deno.writeTextFile(join(malformedDirectory, "SKILL.md"), "---\nname: [\n---\nmalformed body");
        const readableFallback = await writeSkill(
            homeDir,
            join(".agents", "skills"),
            "readable-fallback",
            "readable-fallback",
            "readable lower layer",
        );
        await assertPublicSelection(
            projectRoot,
            "readable-fallback",
            readableFallback,
            "external",
            "readable lower layer",
        );

        const blankName = await writeSkill(
            projectRoot,
            join(".wld", "skills"),
            "blank-name-fallback",
            "   ",
            "blank name",
        );
        await assertPublicSelection(projectRoot, "blank-name-fallback", blankName, "local", "blank name");
    });
});

Deno.test("Skill catalog protects bundled names and lets wld layers override them", async () => {
    await withRuntimeCommandFixture("skill-catalog-bundled-", async ({ projectRoot, homeDir }) => {
        const projectExternalDeclaredAlias = await writeSkill(
            projectRoot,
            join(".agents", "skills"),
            "external-research-alias",
            "research",
            "project external declared",
        );
        const projectExternalDirectoryAlias = await writeSkill(
            projectRoot,
            join(".agents", "skills"),
            "research",
            "external-renamed-research",
            "project external directory",
        );
        const homeExternal = await writeSkill(
            homeDir,
            join(".agents", "skills"),
            "research-copy",
            "research",
            "home external",
        );

        const bundled = (await listSkills({ cwd: projectRoot })).find((skill) => skill.name === "research");
        assertEquals(bundled?.source, "bundled");
        assertEquals(
            (await listSkills({ cwd: projectRoot })).some((skill) => skill.name === "external-renamed-research"),
            false,
        );
        const bundledExpansion = await expandSkillCommand("research", undefined, projectRoot);
        assertEquals(bundledExpansion.includes("project external"), false);
        for (const alias of ["external-research-alias", "external-renamed-research", "research-copy"]) {
            assertEquals(
                (await resolveNamedInvocation({ cwd: projectRoot, text: `/skill:${alias}` })).kind,
                "ordinary",
            );
        }
        for (const excludedPath of [projectExternalDeclaredAlias, projectExternalDirectoryAlias, homeExternal]) {
            assertEquals(bundledExpansion.includes(excludedPath), false);
        }

        const homeOverride = await writeSkill(
            homeDir,
            join(".wld", "skills"),
            "home-research",
            "research",
            "home wld research",
        );
        await assertPublicSelection(projectRoot, "research", homeOverride, "home", "home wld research");

        const projectOverride = await writeSkill(
            projectRoot,
            join(".wld", "skills"),
            "project-research",
            "research",
            "project wld research",
        );
        await assertPublicSelection(projectRoot, "research", projectOverride, "local", "project wld research");
    });
});

Deno.test("Skill catalog uses one winner for published names and keeps only its directory alias", async () => {
    await withRuntimeCommandFixture("skill-catalog-published-name-", async ({ projectRoot, homeDir }) => {
        const winnerPath = await writeSkill(
            projectRoot,
            join(".agents", "skills"),
            "project-alias",
            "shared-published-name",
            "project winner",
        );
        await writeSkill(
            homeDir,
            join(".wld", "skills"),
            "home-alias",
            "shared-published-name",
            "home loser",
        );

        await assertPublicSelection(projectRoot, "shared-published-name", winnerPath, "external", "project winner");
        const byWinnerAlias = await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:project-alias" });
        assertEquals(byWinnerAlias.kind, "skill");
        if (byWinnerAlias.kind === "skill") assertStringIncludes(byWinnerAlias.expandedRequest, "project winner body");
        assertEquals((await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:home-alias" })).kind, "ordinary");
    });
});

Deno.test("Skill catalog disables both external scopes and does not scan a Project without cwd", async () => {
    await withRuntimeCommandFixture("skill-catalog-disabled-", async ({ projectRoot, homeDir }) => {
        const projectExternal = await writeSkill(
            projectRoot,
            join(".agents", "skills"),
            "project-external-only",
            "project-external-only",
            "project external only",
        );
        const homeExternal = await writeSkill(
            homeDir,
            join(".agents", "skills"),
            "home-external-only",
            "home-external-only",
            "home external only",
        );
        const projectOnly = await writeSkill(
            projectRoot,
            join(".wld", "skills"),
            "project-only",
            "project-only",
            "project only",
        );
        const homeOverride = await writeSkill(
            homeDir,
            join(".wld", "skills"),
            "home-research",
            "research",
            "disabled home wld",
        );
        const projectOverride = await writeSkill(
            projectRoot,
            join(".wld", "skills"),
            "project-research",
            "research",
            "disabled project wld",
        );
        await setCustomSetting("enableExternalSkills", false, "global", projectRoot);

        const skills = await listSkills({ cwd: projectRoot });
        assertEquals(skills.some((skill) => skill.path === projectExternal || skill.path === homeExternal), false);
        assertEquals(
            (await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:project-external-only" })).kind,
            "ordinary",
        );
        assertEquals(
            (await resolveNamedInvocation({ cwd: projectRoot, text: "/skill:home-external-only" })).kind,
            "ordinary",
        );
        await assertPublicSelection(projectRoot, "research", projectOverride, "local", "disabled project wld");
        await Deno.remove(join(projectRoot, ".wld", "skills", "project-research"), { recursive: true });
        await assertPublicSelection(projectRoot, "research", homeOverride, "home", "disabled home wld");
        await Deno.remove(join(homeDir, ".wld", "skills", "home-research"), { recursive: true });
        assertEquals(
            (await listSkills({ cwd: projectRoot })).find((skill) => skill.name === "research")?.source,
            "bundled",
        );

        assertEquals((await listSkills()).some((skill) => skill.path === projectOnly), false);
        const secondProject = join(homeDir, "second-project");
        await Deno.mkdir(secondProject);
        assertEquals((await listSkills({ cwd: secondProject })).some((skill) => skill.path === projectOnly), false);
    });
});

Deno.test("Agent Session keeps Pi skills empty before and after Runtime reload", async () => {
    await withRuntimeCommandFixture(
        "skill-catalog-pi-disabled-",
        async ({ projectRoot, homeDir, setModelResponseFactories }) => {
            const homeWinner = await writeSkill(
                homeDir,
                join(".wld", "skills"),
                "shared-runtime-skill",
                "shared-runtime-skill",
                "home runtime winner",
            );
            const excludedExternal = await writeSkill(
                homeDir,
                join(".agents", "skills"),
                "shared-runtime-skill",
                "shared-runtime-skill",
                "external runtime loser",
            );
            const projectExternal = await writeSkill(
                projectRoot,
                join(".agents", "skills"),
                "project-runtime-skill",
                "project-runtime-skill",
                "project runtime winner",
            );
            const piOnly = await writeSkill(homeDir, "pi-only", "pi-only-skill", "pi-only-skill", "pi only");
            await setCustomSetting("skills", [piOnly], "global", projectRoot);

            const unrestricted = new DefaultResourceLoader({
                cwd: projectRoot,
                agentDir: join(homeDir, ".wld"),
                noExtensions: true,
                noContextFiles: true,
                noPromptTemplates: true,
            });
            await unrestricted.reload();
            assertEquals(unrestricted.getSkills().skills.some((skill) => skill.name === "pi-only-skill"), true);

            const built = await buildAgentSession({ cwd: projectRoot, agentName: "guide" });
            try {
                assertEquals(built.session.resourceLoader.getSkills().skills, []);
                await built.session.resourceLoader.reload();
                assertEquals(built.session.resourceLoader.getSkills().skills, []);
            } finally {
                built.session.dispose();
            }

            const prompts: string[] = [];
            const requests: string[] = [];
            setModelResponseFactories([
                (context: TranscriptContext) => {
                    prompts.push(getCurrentSystemPrompt(context.messages));
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("before reload"));
                },
                (context: TranscriptContext) => {
                    prompts.push(getCurrentSystemPrompt(context.messages));
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("after reload"));
                },
                (context: TranscriptContext) => {
                    prompts.push(getCurrentSystemPrompt(context.messages));
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("Pi-only request"));
                },
            ]);
            const runtime = createSessionRuntime();
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.promptUserTurn(created.sessionId, { initialRequest: "before reload", initialImages: [] });
                assertEquals(await runtime.reloadSession(created.sessionId), { ok: true });
                await runtime.promptUserTurn(created.sessionId, { initialRequest: "after reload", initialImages: [] });
                await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/skill:pi-only-skill",
                    initialImages: [],
                });

                for (const prompt of prompts) {
                    assertEquals(count(prompt, homeWinner), 1);
                    assertEquals(count(prompt, projectExternal), 1);
                    assertEquals(prompt.includes(excludedExternal), false);
                    assertEquals(prompt.includes(piOnly), false);
                    assertEquals(prompt.includes("pi-only-skill"), false);
                }
                assertStringIncludes(requests[2], "/skill:pi-only-skill");
                assertEquals(requests[2].includes("pi only body"), false);
                const root = runtime.getSessionSnapshot(created.sessionId);
                assertEquals(root?.activeAgent !== null, true);
            } finally {
                runtime.closeAllSessions();
            }
        },
    );
});

Deno.test("disabled external Skill requests cannot reach the model through Pi fallback", async () => {
    await withRuntimeCommandFixture(
        "skill-catalog-disabled-runtime-",
        async ({ projectRoot, homeDir, setModelResponseFactories }) => {
            await writeSkill(
                projectRoot,
                join(".agents", "skills"),
                "disabled-runtime-skill",
                "disabled-runtime-skill",
                "disabled external secret",
            );
            await writeSkill(
                projectRoot,
                join(".wld", "skills"),
                "selected-runtime-skill",
                "selected-runtime-skill",
                "selected core body",
            );
            await setCustomSetting("enableExternalSkills", false, "global", projectRoot);
            await setCustomSetting(
                "skills",
                [join(homeDir, ".agents", "skills", "disabled-runtime-skill", "SKILL.md")],
                "global",
                projectRoot,
            );

            const requests: string[] = [];
            setModelResponseFactories([
                (context: TranscriptContext) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("external request seen"));
                },
                (context: TranscriptContext) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("core request seen"));
                },
            ]);
            const runtime = createSessionRuntime();
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/skill:disabled-runtime-skill",
                    initialImages: [],
                });
                await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/skill:selected-runtime-skill exact extra",
                    initialImages: [],
                });

                assertStringIncludes(requests[0], "/skill:disabled-runtime-skill");
                assertEquals(requests[0].includes("disabled external secret body"), false);
                assertStringIncludes(requests[1], "selected core body");
                assertStringIncludes(requests[1], "exact extra");
            } finally {
                runtime.closeAllSessions();
            }
        },
    );
});
