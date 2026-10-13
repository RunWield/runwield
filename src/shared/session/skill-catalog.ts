import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { extractYaml, test as hasFrontMatter } from "../front-matter.ts";
import { dirname, join, resolve } from "node:path";
import { SKILLS_DIR } from "../../constants.js";
import {
    assertPersonalResourcePath,
    personalAgentsRoot,
    personalGlobalRoot,
    PersonalResourcePathError,
} from "../remote/personal-resources.ts";
import { directoryExists, fileExists } from "../helpers.ts";
import { getCustomSetting } from "../settings.js";
import { extractBundledSkills } from "./agent-assets.ts";

export type SkillSource = "local" | "home" | "bundled" | "external";

export interface SkillRecord {
    name: string;
    description: string;
    path: string;
    source: SkillSource;
    disableModelInvocation: boolean;
    directoryName: string;
}

type SkillLayer = {
    dir: string;
    source: SkillSource;
    external: boolean;
};

type SkillCandidate = SkillRecord & {
    identities: string[];
};

type SkillFrontMatter = {
    name?: string;
    description?: string;
    "disable-model-invocation"?: boolean | string;
};

async function bundledSkillDirectories(): Promise<string[]> {
    const extracted = await extractBundledSkills();
    return extracted && extracted !== SKILLS_DIR ? [extracted, SKILLS_DIR] : [SKILLS_DIR];
}

async function readLayer(layer: SkillLayer): Promise<SkillCandidate[]> {
    await assertPersonalResourcePath(layer.dir, `${layer.source} Skill directory`);
    if (!(await directoryExists(layer.dir))) return [];
    const candidates: SkillCandidate[] = [];
    try {
        for await (const entry of await fsReaddir(layer.dir, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const skillDir = join(layer.dir, entry.name);
            await assertPersonalResourcePath(skillDir, `${layer.source} Skill directory`);
            if (!(await directoryExists(skillDir))) continue;
            const path = join(skillDir, "SKILL.md");
            await assertPersonalResourcePath(path, `${layer.source} Skill`);
            if (!(await fileExists(path))) continue;
            try {
                const raw = await fsReadFile(path, "utf8");
                let attrs: SkillFrontMatter = {};
                if (hasFrontMatter(raw)) attrs = extractYaml(raw).attrs as SkillFrontMatter;
                const declaredName = typeof attrs.name === "string" ? attrs.name.trim() : "";
                const name = declaredName || entry.name;
                const description = typeof attrs.description === "string"
                    ? attrs.description.trim()
                    : "No description provided";
                const disabled = attrs["disable-model-invocation"];
                candidates.push({
                    name,
                    description,
                    path,
                    source: layer.source,
                    disableModelInvocation: disabled === true || disabled === "true",
                    directoryName: entry.name,
                    identities: name === entry.name ? [name] : [name, entry.name],
                });
            } catch (error) {
                if (error instanceof PersonalResourcePathError) throw error;
                // Ignore unreadable or malformed skills without reserving their names.
            }
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return candidates;
}

function conflicts(candidate: SkillCandidate, claimed: Set<string>): boolean {
    return candidate.identities.some((identity) => claimed.has(identity));
}

/** Return the selected Skill records for one Project and current settings. */
export async function listSkills(options: { cwd?: string } = {}): Promise<SkillRecord[]> {
    const bundledDirs = await bundledSkillDirectories();
    const bundledLayers = bundledDirs.map((dir): SkillLayer => ({ dir, source: "bundled", external: false }));
    const bundledCandidatesByDirectory = new Map<string, SkillCandidate[]>();
    for (const layer of bundledLayers) bundledCandidatesByDirectory.set(layer.dir, await readLayer(layer));
    const bundledCandidates = Array.from(bundledCandidatesByDirectory.values()).flat();
    const protectedBundledNames = new Set(bundledCandidates.flatMap((candidate) => candidate.identities));
    const projectRoot = options.cwd ? resolve(options.cwd) : undefined;
    const home = personalGlobalRoot();
    const externalRoot = personalAgentsRoot();
    const externalEnabled = (getCustomSetting("enableExternalSkills", "global", options.cwd) ?? true) !== false;
    const layers: SkillLayer[] = [
        ...(projectRoot
            ? [
                { dir: join(projectRoot, ".wld", "skills"), source: "local", external: false } as const,
                ...(externalEnabled
                    ? [{ dir: join(projectRoot, ".agents", "skills"), source: "external", external: true } as const]
                    : []),
            ]
            : []),
        ...(home
            ? [
                { dir: join(home, "skills"), source: "home", external: false } as const,
                ...(externalEnabled && externalRoot
                    ? [{ dir: join(externalRoot, "skills"), source: "external", external: true } as const]
                    : []),
            ]
            : []),
        ...bundledLayers,
    ];

    const selected: SkillRecord[] = [];
    const claimed = new Set<string>();
    for (const layer of layers) {
        const candidates = bundledCandidatesByDirectory.get(layer.dir) ?? await readLayer(layer);
        for (const candidate of candidates) {
            if (layer.external && conflicts(candidate, protectedBundledNames)) continue;
            if (conflicts(candidate, claimed)) continue;
            const { identities: _identities, ...record } = candidate;
            selected.push(record);
            for (const identity of candidate.identities) claimed.add(identity);
        }
    }
    return selected;
}

/** Find one selected Skill by its published name or selected directory alias. */
export async function findSkill(name: string, options: { cwd?: string } = {}): Promise<SkillRecord | null> {
    const skills = await listSkills(options);
    return skills.find((skill) => skill.name === name || skill.directoryName === name) ?? null;
}

/** Expand an already selected Skill record for a model turn. */
export async function expandSkillRecord(skill: SkillRecord, additionalInstructions?: string): Promise<string> {
    try {
        await assertPersonalResourcePath(skill.path, `Skill "${skill.name}"`);
        const raw = await fsReadFile(skill.path, "utf8");
        const body = (hasFrontMatter(raw) ? extractYaml(raw).body : raw).trim();
        const skillBlock = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${
            dirname(skill.path)
        }.\n\n${body}\n</skill>`;
        const expanded =
            `The user has invoked the "${skill.name}" skill. Follow the instructions below:\n\n${skillBlock}`;
        return additionalInstructions ? `${expanded}\n\n${additionalInstructions}` : expanded;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read skill "${skill.name}": ${message}`);
    }
}

/** Find and expand one selected Skill for a model turn. */
export async function expandSkill(
    name: string,
    additionalInstructions?: string,
    options: { cwd?: string } = {},
): Promise<string> {
    const skill = await findSkill(name, options);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return await expandSkillRecord(skill, additionalInstructions);
}
