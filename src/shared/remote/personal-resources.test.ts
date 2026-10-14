import { symlink } from "node:fs/promises";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { assertPersonalResourcePath, assertPersonalResourcePathSync, configureRemotePersonalResources } from "./personal-resources.ts";
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

test("remote personal resources select mounted files while project settings keep priority", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-test-"));
    const project = await fixture.checkout();
    try {
        const globalRoot = join(root, "private", "global");
        const agentsRoot = join(root, "private", "agents");
        await fsMkdir(join(globalRoot, "skills", "personal"), { recursive: true });
        await fsMkdir(join(globalRoot, "agents"), { recursive: true });
        await fsMkdir(join(globalRoot, "installed", "prompts"), { recursive: true });
        await fsWriteFile(
            join(globalRoot, "installed", "package.json"),
            JSON.stringify({
                name: "inside-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await fsWriteFile(join(globalRoot, "installed", "prompts", "inside.md"), "# Mounted package");
        const managedRoot = join(globalRoot, "managed");
        await fsMkdir(join(managedRoot, "prompts"), { recursive: true });
        await fsWriteFile(
            join(managedRoot, "package.json"),
            JSON.stringify({
                name: "managed-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await fsWriteFile(join(managedRoot, "prompts", "managed.md"), "# Mounted managed package");
        await fsMkdir(join(project, ".wld", "skills", "personal"), { recursive: true });
        await fsMkdir(join(agentsRoot, "skills", "external"), { recursive: true });
        const packageRoot = join(root, "private", "package-2");
        await fsMkdir(join(packageRoot, "prompts"), { recursive: true });
        await fsWriteFile(
            join(packageRoot, "package.json"),
            JSON.stringify({
                name: "personal-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await fsWriteFile(join(packageRoot, "prompts", "personal-package.md"), "# Laptop package prompt");
        await fsMkdir(join(project, ".wld", "prompts"), { recursive: true });
        await fsWriteFile(join(project, ".wld", "prompts", "personal-package.md"), "# Project prompt");
        const projectPackage = join(project, "project-package");
        await fsMkdir(join(projectPackage, "prompts"), { recursive: true });
        await fsWriteFile(
            join(projectPackage, "package.json"),
            JSON.stringify({
                name: "project-package",
                version: "1.0.0",
                pi: { prompts: ["prompts/*.md"] },
            }),
        );
        await fsWriteFile(join(projectPackage, "prompts", "project-package.md"), "# Project package");
        await fsWriteFile(
            join(globalRoot, "settings.json"),
            JSON.stringify({
                marker: "personal",
                theme: "dark",
                agents: { global: true },
                packages: ["../package", "/laptop/.wld/installed", "npm:managed-package", "npm:remote-only"],
            }),
        );
        await fsWriteFile(join(globalRoot, "RUNWIELD.md"), "personal instruction");
        await fsWriteFile(
            join(globalRoot, "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nPersonal",
        );
        await fsWriteFile(
            join(project, ".wld", "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nProject",
        );
        await fsWriteFile(
            join(agentsRoot, "skills", "external", "SKILL.md"),
            "---\nname: external\n---\nExternal",
        );
        await fsWriteFile(join(agentsRoot, "AGENTS.md"), "external instruction");
        await fsWriteFile(
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
        await fsWriteFile(
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
        await fsMkdir(join(linked, ".wld", "skills", "personal"), { recursive: true });
        await fsMkdir(join(linked, ".wld", "agents"), { recursive: true });
        await fsMkdir(join(linked, ".wld", "prompts"), { recursive: true });
        await fsWriteFile(
            join(linked, ".wld", "skills", "personal", "SKILL.md"),
            "---\nname: personal\n---\nLinked Skill",
        );
        await fsWriteFile(
            join(linked, ".wld", "agents", "linked-engineer.md"),
            "---\nname: Linked Engineer\npromptOverride: true\n---\nLinked Agent",
        );
        await fsWriteFile(join(linked, ".wld", "prompts", "personal-package.md"), "# Linked prompt");
        await fsWriteFile(join(linked, ".wld", "settings.json"), JSON.stringify({ marker: "linked" }));
        await fsWriteFile(
            join(globalRoot, "agents", "linked-engineer.md"),
            "---\nname: Mounted Engineer\n---\nMounted Agent",
        );

        assertEquals(getSettingsDir("project", linked), join(await fsRealpath(project), ".wld"));
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
        await fsMkdir(remoteAccount);
        const remoteFile = join(remoteAccount, "SKILL.md");
        await fsWriteFile(remoteFile, "REMOTE ACCOUNT BYTES");
        const mountedSkill = join(globalRoot, "skills", "personal", "SKILL.md");
        await fsRm(mountedSkill);
        await symlink(remoteFile, mountedSkill);
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
        await fsRm(mountedSkill);
        await symlink("../sibling/SKILL.md", mountedSkill);
        await fsMkdir(join(globalRoot, "skills", "sibling"));
        await fsWriteFile(join(globalRoot, "skills", "sibling", "SKILL.md"), "---\nname: sibling\n---\nValid");
        assertEquals((await listSkills()).some((skill) => skill.name === "sibling"), true);

        const instruction = join(globalRoot, "RUNWIELD.md");
        await fsRm(instruction);
        await symlink(remoteFile, instruction);
        await assertRejects(() => readGlobalAgentMd(root), Error, instruction);
        const homePrompt = join(globalRoot, "prompts", "personal.md");
        await fsMkdir(join(globalRoot, "prompts"));
        await symlink(remoteFile, homePrompt);
        await assertRejects(() => listPromptTemplates({ cwd: project }), Error, homePrompt);
        await assertRejects(() => expandPromptTemplate(homePrompt), Error, homePrompt);
        await assertRejects(() => assertPersonalResourcePath(homePrompt, "personal prompt"), Error, homePrompt);
        const agentPath = join(globalRoot, "agents", "engineer.md");
        await symlink(remoteFile, agentPath);
        await assertRejects(() => listAgentDefNames(), Error, agentPath);
        await assertRejects(() => loadAgentDef("engineer"), Error, agentPath);
        assertThrows(() => getAgentDisplayName("engineer"), Error, agentPath);
        const packagePrompt = join(packageRoot, "prompts", "personal-package.md");
        await fsRm(packagePrompt);
        await symlink(remoteFile, packagePrompt);
        await assertRejects(
            () => assertPersonalResourcePath(packagePrompt, "package prompt", { packageResource: true }),
            Error,
            packagePrompt,
        );
        const packageManifest = join(packageRoot, "package.json");
        await fsRm(packageManifest);
        await symlink(remoteFile, packageManifest);
        await assertRejects(() => resolveInstalledPackagePromptResources({ cwd: project }), Error, packageManifest);
        await fsRm(homePrompt);
        await symlink("/laptop/missing/prompt.md", homePrompt);
        await assertRejects(() => assertPersonalResourcePath(homePrompt, "personal prompt"), Error, homePrompt);

        // A detached package mount leaves an empty private directory on the
        // same device. Missing optional files must not look healthy there.
        await fsRename(packageRoot, join(root, "detached-package"));
        await fsMkdir(packageRoot);
        await fsChmod(packageRoot, 0o500);
        await assertRejects(
            () => assertPersonalResourcePath(packageManifest, "package manifest", { packageResource: true }),
            Error,
            "changed identity",
        );
        // Both reader variants must reject replacement of the activated root,
        // even when the requested file is optional and missing in its replacement.
        await fsRename(globalRoot, join(root, "detached-global"));
        await fsMkdir(globalRoot);
        const optionalResource = join(globalRoot, "optional.md");
        assertThrows(
            () => assertPersonalResourcePathSync(optionalResource, "personal resource"),
            Error,
            "changed identity",
        );
        await assertRejects(
            () => assertPersonalResourcePath(optionalResource, "personal resource"),
            Error,
            "changed identity",
        );
    } finally {
        await fsRm(root, { recursive: true });
        await fsRm(project, { recursive: true });
    }
});
