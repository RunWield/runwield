import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { assertPersonalResourcePath, configureRemotePersonalResources } from "./personal-resources.ts";
import {
    getCustomSetting,
    getExactProjectCustomSetting,
    getMergedCustomSetting,
    getSettingsDir,
    getSettingsManager,
    setCustomSetting,
} from "../settings.js";
import {
    expandPromptTemplate,
    getGlobalAgentMdPaths,
    getPromptTemplatePaths,
    listPromptTemplates,
    readGlobalAgentMd,
} from "../session/session.js";
import { resolveInstalledPackagePromptResources } from "../package-resources.ts";
import { expandSkillRecord, listSkills } from "../session/skill-catalog.ts";
import { getAgentDisplayName, listAgentDefNames, loadAgentDef, resolveAgentDefsDir } from "../session/agents.js";
import { createRootSessionManager, getRunWieldSessionsBaseDir } from "../session/root-session.js";
import { openFileSessionStore } from "../session/file-session-store.ts";

const fixture = defineCommittedGitFixture();

Deno.test("remote personal resources select mounted files while project settings keep priority", async () => {
    const root = await Deno.makeTempDir();
    const project = await fixture.checkout();
    try {
        const globalRoot = join(root, "private", "global");
        const agentsRoot = join(root, "private", "agents");
        await Deno.mkdir(join(globalRoot, "skills", "personal"), { recursive: true });
        await Deno.mkdir(join(globalRoot, "agents"), { recursive: true });
        await Deno.mkdir(join(globalRoot, "installed", "prompts"), { recursive: true });
        await Deno.writeTextFile(
            join(globalRoot, "installed", "package.json"),
            JSON.stringify({
                name: "inside-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await Deno.writeTextFile(join(globalRoot, "installed", "prompts", "inside.md"), "# Mounted package");
        const managedRoot = join(globalRoot, "managed");
        await Deno.mkdir(join(managedRoot, "prompts"), { recursive: true });
        await Deno.writeTextFile(
            join(managedRoot, "package.json"),
            JSON.stringify({
                name: "managed-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await Deno.writeTextFile(join(managedRoot, "prompts", "managed.md"), "# Mounted managed package");
        await Deno.mkdir(join(project, ".wld", "skills", "personal"), { recursive: true });
        await Deno.mkdir(join(agentsRoot, "skills", "external"), { recursive: true });
        const packageRoot = join(root, "private", "package-2");
        await Deno.mkdir(join(packageRoot, "prompts"), { recursive: true });
        await Deno.writeTextFile(
            join(packageRoot, "package.json"),
            JSON.stringify({
                name: "personal-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await Deno.writeTextFile(join(packageRoot, "prompts", "personal-package.md"), "# Laptop package prompt");
        await Deno.mkdir(join(project, ".wld", "prompts"), { recursive: true });
        await Deno.writeTextFile(join(project, ".wld", "prompts", "personal-package.md"), "# Project prompt");
        const projectPackage = join(project, "project-package");
        await Deno.mkdir(join(projectPackage, "prompts"), { recursive: true });
        await Deno.writeTextFile(
            join(projectPackage, "package.json"),
            JSON.stringify({
                name: "project-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await Deno.writeTextFile(join(projectPackage, "prompts", "project-package.md"), "# Project package");
        await Deno.writeTextFile(
            join(globalRoot, "settings.json"),
            JSON.stringify({
                marker: "personal",
                theme: "dark",
                agents: { global: true },
                packages: ["../package", "/laptop/.wld/installed", "npm:managed-package", "npm:remote-only"],
            }),
        );
        await Deno.writeTextFile(join(globalRoot, "RUNWIELD.md"), "personal instruction");
        await Deno.writeTextFile(
            join(globalRoot, "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nPersonal",
        );
        await Deno.writeTextFile(
            join(project, ".wld", "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nProject",
        );
        await Deno.writeTextFile(
            join(agentsRoot, "skills", "external", "SKILL.md"),
            "---\nname: external\n---\nExternal",
        );
        await Deno.writeTextFile(join(agentsRoot, "AGENTS.md"), "external instruction");
        await Deno.writeTextFile(
            join(project, ".wld", "settings.json"),
            JSON.stringify({ marker: "project", agents: { project: true }, packages: ["../project-package"] }),
        );
        configureRemotePersonalResources({
            globalRoot,
            agentsRoot,
            packageRoots: {
                "../package": packageRoot,
                "/laptop/.wld/installed": join(globalRoot, "installed"),
                "npm:managed-package": managedRoot,
            },
        });
        assertEquals(getSettingsDir("global", project), globalRoot);
        assertEquals(getSettingsManager(project).getProjectSettings().packages, ["../project-package"]);
        assertEquals(await resolveAgentDefsDir(project), join(globalRoot, "agents"));
        assertEquals(getMergedCustomSetting("marker", project), "project");
        assertEquals(getMergedCustomSetting("agents", project), { global: true, project: true });
        assertEquals(getExactProjectCustomSetting("marker", project), "project");
        assertEquals(getCustomSetting("marker", "global", project), "personal");
        const manager = getSettingsManager(project);
        assertEquals(manager.getTheme(), "dark");
        await Deno.writeTextFile(
            join(globalRoot, "settings.json"),
            JSON.stringify({
                marker: "personal",
                theme: "light",
                agents: { updated: true },
                packages: ["../package", "/laptop/.wld/installed", "npm:managed-package", "npm:remote-only"],
            }),
        );
        await manager.reload();
        assertEquals(manager.getTheme(), "light");
        assertEquals(getGlobalAgentMdPaths(root), [
            join(globalRoot, "RUNWIELD.md"),
            join(globalRoot, "AGENTS.md"),
            join(agentsRoot, "AGENTS.md"),
        ]);
        assertEquals(await readGlobalAgentMd(root), "personal instruction");
        assertEquals(getPromptTemplatePaths(project).slice(0, 2), [
            join(project, ".wld", "prompts"),
            join(globalRoot, "prompts"),
        ]);
        assertEquals(
            (await resolveInstalledPackagePromptResources({ cwd: project })).map((resource) => [
                resource.path,
                resource.metadata.source,
            ]),
            [
                [join(projectPackage, "prompts", "project-package.md"), "../project-package"],
                [join(packageRoot, "prompts", "personal-package.md"), "../package"],
                [join(globalRoot, "installed", "prompts", "inside.md"), "/laptop/.wld/installed"],
                [join(managedRoot, "prompts", "managed.md"), "npm:managed-package"],
            ],
        );
        assertEquals(
            (await listPromptTemplates({ cwd: project })).find((prompt) => prompt.name === "personal-package")?.path,
            join(project, ".wld", "prompts", "personal-package.md"),
        );
        const skills = await listSkills({ cwd: project });
        assertEquals(
            skills.find((skill) => skill.name === "personal")?.path,
            join(project, ".wld", "skills", "personal", "SKILL.md"),
        );
        assertEquals(
            skills.find((skill) => skill.name === "external")?.path,
            join(agentsRoot, "skills", "external", "SKILL.md"),
        );

        // Resource readers use the selected linked worktree, but ordinary
        // project settings still belong to the primary checkout.
        const linked = join(root, "linked");
        await git(project, ["worktree", "add", "-b", "linked", linked]);
        await Deno.mkdir(join(linked, ".wld", "skills", "personal"), { recursive: true });
        await Deno.mkdir(join(linked, ".wld", "agents"), { recursive: true });
        await Deno.mkdir(join(linked, ".wld", "prompts"), { recursive: true });
        await Deno.writeTextFile(
            join(linked, ".wld", "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nLinked Skill",
        );
        await Deno.writeTextFile(
            join(linked, ".wld", "agents", "linked-engineer.md"),
            "---\nname: Linked Engineer\npromptOverride: true\n---\nLinked Agent",
        );
        await Deno.writeTextFile(join(linked, ".wld", "prompts", "personal-package.md"), "# Linked prompt");
        await Deno.writeTextFile(join(linked, ".wld", "settings.json"), JSON.stringify({ marker: "linked" }));
        await Deno.writeTextFile(
            join(globalRoot, "agents", "linked-engineer.md"),
            "---\nname: Mounted Engineer\n---\nMounted Agent",
        );

        assertEquals(getSettingsDir("project", linked), join(await Deno.realPath(project), ".wld"));
        assertEquals(getCustomSetting("marker", "project", linked), "project");
        assertEquals(getExactProjectCustomSetting("marker", linked), "linked");
        assertEquals(getMergedCustomSetting("marker", linked), "project");
        assertEquals(getCustomSetting("marker", "global", linked), "personal");
        assertEquals(await resolveAgentDefsDir(linked), join(linked, ".wld", "agents"));
        assertEquals((await listAgentDefNames(linked)).includes("linked-engineer"), true);
        const linkedAgent = await loadAgentDef("linked-engineer", linked);
        assertEquals(linkedAgent.displayName, "Linked Engineer");
        assertEquals(linkedAgent.systemPrompt.includes("Linked Agent"), true);
        assertEquals(linkedAgent.systemPrompt.includes("Mounted Agent"), false);
        assertEquals(getAgentDisplayName("linked-engineer", linked), "Linked Engineer");
        const linkedSkill = (await listSkills({ cwd: linked })).find((skill) => skill.name === "personal");
        assertEquals(linkedSkill?.path, join(linked, ".wld", "skills", "personal", "SKILL.md"));
        if (!linkedSkill) throw new Error("Linked Skill was not selected");
        assertEquals((await expandSkillRecord(linkedSkill)).includes("Linked Skill"), true);
        assertEquals(getPromptTemplatePaths(linked)[0], join(linked, ".wld", "prompts"));
        const linkedPrompt = (await listPromptTemplates({ cwd: linked })).find((prompt) =>
            prompt.name === "personal-package"
        );
        assertEquals(linkedPrompt?.path, join(linked, ".wld", "prompts", "personal-package.md"));
        if (!linkedPrompt) throw new Error("Linked prompt was not selected");
        assertEquals((await expandPromptTemplate(linkedPrompt.path)).includes("Linked prompt"), true);

        await setCustomSetting("marker", "updated primary", "project", linked);
        assertEquals(getCustomSetting("marker", "project", linked), "updated primary");
        assertEquals(getExactProjectCustomSetting("marker", project), "updated primary");
        assertEquals(getExactProjectCustomSetting("marker", linked), "linked");
        assertEquals(getMergedCustomSetting("marker", linked), "updated primary");

        assertThrows(() => getRunWieldSessionsBaseDir(), Error, "laptop-native writer guard");
        assertThrows(
            () => openFileSessionStore({ baseDir: join(root, "sessions") }),
            Error,
            "laptop-native writer guard",
        );
        await assertRejects(() => createRootSessionManager("new", project), Error, "laptop-native writer guard");
        await assertRejects(
            () => setCustomSetting("marker", "changed", "global", project),
            Error,
            "laptop settings service",
        );
        assertEquals(getCustomSetting("marker", "global", project), "personal");

        // These laptop absolute targets exist on the server under a different
        // account. None is authorized by the verified laptop mount.
        const remoteAccount = join(root, "remote-account");
        await Deno.mkdir(remoteAccount);
        const remoteFile = join(remoteAccount, "SKILL.md");
        await Deno.writeTextFile(remoteFile, "REMOTE ACCOUNT BYTES");
        const mountedSkill = join(globalRoot, "skills", "personal", "SKILL.md");
        await Deno.remove(mountedSkill);
        await Deno.symlink(remoteFile, mountedSkill);
        await assertRejects(() => listSkills(), Error, mountedSkill);
        await assertRejects(
            () =>
                expandSkillRecord({
                    name: "personal",
                    description: "",
                    path: mountedSkill,
                    source: "home",
                    disableModelInvocation: false,
                    directoryName: "personal",
                }),
            Error,
            mountedSkill,
        );
        await Deno.remove(mountedSkill);
        await Deno.symlink("../sibling/SKILL.md", mountedSkill);
        await Deno.mkdir(join(globalRoot, "skills", "sibling"));
        await Deno.writeTextFile(join(globalRoot, "skills", "sibling", "SKILL.md"), "---\nname: sibling\n---\nValid");
        assertEquals((await listSkills()).some((skill) => skill.name === "sibling"), true);

        const instruction = join(globalRoot, "RUNWIELD.md");
        await Deno.remove(instruction);
        await Deno.symlink(remoteFile, instruction);
        await assertRejects(() => readGlobalAgentMd(root), Error, instruction);
        const homePrompt = join(globalRoot, "prompts", "personal.md");
        await Deno.mkdir(join(globalRoot, "prompts"));
        await Deno.symlink(remoteFile, homePrompt);
        await assertRejects(() => listPromptTemplates({ cwd: project }), Error, homePrompt);
        await assertRejects(() => expandPromptTemplate(homePrompt), Error, homePrompt);
        await assertRejects(() => assertPersonalResourcePath(homePrompt, "personal prompt"), Error, homePrompt);
        const agentPath = join(globalRoot, "agents", "engineer.md");
        await Deno.symlink(remoteFile, agentPath);
        await assertRejects(() => listAgentDefNames(), Error, agentPath);
        await assertRejects(() => loadAgentDef("engineer"), Error, agentPath);
        assertThrows(() => getAgentDisplayName("engineer"), Error, agentPath);
        const packagePrompt = join(packageRoot, "prompts", "personal-package.md");
        await Deno.remove(packagePrompt);
        await Deno.symlink(remoteFile, packagePrompt);
        await assertRejects(
            () => assertPersonalResourcePath(packagePrompt, "package prompt", { packageResource: true }),
            Error,
            packagePrompt,
        );
        const packageManifest = join(packageRoot, "package.json");
        await Deno.remove(packageManifest);
        await Deno.symlink(remoteFile, packageManifest);
        await assertRejects(() => resolveInstalledPackagePromptResources({ cwd: project }), Error, packageManifest);
        await Deno.remove(homePrompt);
        await Deno.symlink("/laptop/missing/prompt.md", homePrompt);
        await assertRejects(() => assertPersonalResourcePath(homePrompt, "personal prompt"), Error, homePrompt);

        // A detached package mount leaves an empty private directory on the
        // same device. Missing optional files must not look healthy there.
        await Deno.rename(packageRoot, join(root, "detached-package"));
        await Deno.mkdir(packageRoot);
        await Deno.chmod(packageRoot, 0o500);
        await assertRejects(
            () => assertPersonalResourcePath(packageManifest, "package manifest", { packageResource: true }),
            Error,
            "changed identity",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(project, { recursive: true });
    }
});
