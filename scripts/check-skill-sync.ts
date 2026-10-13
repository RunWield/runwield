#!/usr/bin/env bun
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";

/**
 * Keeps the installable skills under `skills/` in step with the Agent Definitions they were derived from.
 *
 * A skill derived from an Agent Definition records the hash of both files. When either side changes, this check fails
 * and names the side that moved, so the edit is carried across before the baseline is accepted again with
 * `bun run skills:sync:update`. A skill that stands on its own records no source and is held to its own hashes.
 *
 * Every Markdown file in a published skill directory is tracked, not only its SKILL.md, and the file list comes from
 * disk rather than from the baseline. A support file added and never registered is still scanned and still reported.
 *
 * It also holds the skills to their reason for existing: they are installed in projects that have never heard of
 * RunWield, so RunWield names, Agent handoffs, and RunWield tool names must not survive the port.
 *
 * Finally it guards the published surface. `npx skills add gandazgul/runwield` offers every skill it finds in the
 * repository's skill container directories, so a skill vendored for our own use would be handed to strangers unless it
 * opts out.
 */

import { fileURLToPath as fromFileUrl } from "node:url";

const BASELINE_PATH = new URL("./skill-sync-baseline.json", import.meta.url);
const REPO_ROOT = new URL("../", import.meta.url);
const REPO_ROOT_PATH = fromFileUrl(REPO_ROOT).replace(/\/$/, "");

export interface SupportFileHash {
    /** Repository-relative path of a Markdown file that ships with the skill. */
    path: string;
    /** SHA-256 of that file when the entry was last reviewed. */
    hash: string;
}

export interface PublishedSkill {
    /** Repository-relative path of the Agent Definition that owns the wording, when one does. */
    source?: string;
    /** Repository-relative path of the published skill's SKILL.md. */
    skill: string;
    /** SHA-256 of the source file when the entry was last reviewed. */
    sourceHash?: string;
    /** SHA-256 of the SKILL.md when the entry was last reviewed. */
    skillHash: string;
    /** Every other Markdown file in the skill's directory, with its hash when the entry was last reviewed. */
    supportFiles: SupportFileHash[];
}

export interface SkillSyncBaseline {
    skills: PublishedSkill[];
}

export interface SkillSyncDrift {
    source?: string;
    skill: string;
    sourceChanged: boolean;
    skillChanged: boolean;
    /** Support files on disk that the baseline does not record. */
    supportFilesAdded: string[];
    /** Support files the baseline records that are no longer on disk. */
    supportFilesRemoved: string[];
    /** Support files whose hash moved. */
    supportFilesChanged: string[];
}

/**
 * Reports every published skill whose recorded hashes no longer match the files on disk.
 */
export function findSkillSyncDrift(recorded: PublishedSkill[], current: PublishedSkill[]): SkillSyncDrift[] {
    const currentBySkill = new Map(current.map((entry) => [entry.skill, entry]));
    const drift: SkillSyncDrift[] = [];
    for (const entry of recorded) {
        const actual = currentBySkill.get(entry.skill);
        if (!actual) continue;
        const sourceChanged = entry.source !== undefined && actual.sourceHash !== entry.sourceHash;
        const skillChanged = actual.skillHash !== entry.skillHash;

        const recordedFiles = new Map((entry.supportFiles ?? []).map((file) => [file.path, file.hash]));
        const actualFiles = new Map((actual.supportFiles ?? []).map((file) => [file.path, file.hash]));
        const supportFilesAdded = [...actualFiles.keys()].filter((path) => !recordedFiles.has(path));
        const supportFilesRemoved = [...recordedFiles.keys()].filter((path) => !actualFiles.has(path));
        const supportFilesChanged = [...actualFiles].filter(([path, hash]) =>
            recordedFiles.has(path) && recordedFiles.get(path) !== hash
        ).map(([path]) => path);

        const moved = sourceChanged || skillChanged || supportFilesAdded.length > 0 ||
            supportFilesRemoved.length > 0 || supportFilesChanged.length > 0;
        if (moved) {
            drift.push({
                source: entry.source,
                skill: entry.skill,
                sourceChanged,
                skillChanged,
                supportFilesAdded,
                supportFilesRemoved,
                supportFilesChanged,
            });
        }
    }
    return drift;
}

/**
 * Turns drift into the instruction a reader needs: which file moved, and which file must catch up.
 */
export function formatDrift(drift: SkillSyncDrift[]): string {
    const lines: string[] = [];
    for (const entry of drift) {
        if (entry.source !== undefined) {
            if (entry.sourceChanged && entry.skillChanged) {
                lines.push(
                    `- ${entry.source} and ${entry.skill} both changed. Confirm the skill still says the same thing.`,
                );
            } else if (entry.sourceChanged) {
                lines.push(`- ${entry.source} changed but ${entry.skill} did not. Carry the change into the skill.`);
            } else if (entry.skillChanged) {
                lines.push(
                    `- ${entry.skill} changed but ${entry.source} did not. Carry the change back into the Agent Definition, unless it only strips project-specific wording.`,
                );
            }
        } else if (entry.skillChanged) {
            lines.push(`- ${entry.skill} changed.`);
        }
        for (const path of entry.supportFilesChanged) lines.push(`- ${path} changed.`);
        for (const path of entry.supportFilesAdded) {
            lines.push(`- ${path} ships with ${entry.skill} but the baseline does not record it.`);
        }
        for (const path of entry.supportFilesRemoved) {
            lines.push(`- ${path} is recorded for ${entry.skill} but is no longer on disk.`);
        }
    }
    return [
        "Published skills no longer match the baseline:",
        ...lines,
        "",
        "Review each file above, then run: bun run skills:sync:update",
    ].join("\n");
}

const PROJECT_SPECIFIC_PATTERNS: { label: string; pattern: RegExp }[] = [
    { label: "RunWield product name", pattern: /\bRunWield\b/g },
    { label: "wld command", pattern: /\bwld\b/g },
    { label: "Agent handoff", pattern: /\/agent [a-z]+/g },
    { label: "prompt template variable", pattern: /\{\{[A-Z_]+\}\}/g },
    { label: "RunWield artifact name", pattern: /\bWork Record|\bPlan Lifecycle\b|\bAgent Definition\b/g },
    {
        label: "RunWield memory tool call",
        pattern: /`memory`|\baction:\s*"(?:recall|store|delete)"/g,
    },
    {
        label: "RunWield tool name",
        pattern:
            /\b(?:user_interview|artifact_written|delegate_agent|task_completed|write_docs|edit_docs|work_record_\w+|web_(?:search|fetch|code_search|docs_search)|code_(?:search|show|outline|batch|refs|impact|trace|investigate|structure|impls|importers)|multi_file_edit)\b/g,
    },
];

export interface ProjectSpecificLeak {
    skill: string;
    label: string;
    term: string;
}

/**
 * Reports RunWield-only vocabulary that a skill must not carry into someone else's project.
 */
export function findProjectSpecificLeaks(skill: string, content: string): ProjectSpecificLeak[] {
    const leaks: ProjectSpecificLeak[] = [];
    const seen = new Set<string>();
    for (const { label, pattern } of PROJECT_SPECIFIC_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
            if (seen.has(match[0])) continue;
            seen.add(match[0]);
            leaks.push({ skill, label, term: match[0] });
        }
    }
    return leaks;
}

export function formatLeaks(leaks: ProjectSpecificLeak[]): string {
    return [
        "Installable skills still carry project-specific wording:",
        ...leaks.map((leak) => `- ${leak.skill}: ${leak.label} "${leak.term}"`),
        "",
        "Say the same thing without naming RunWield, its Agents, or its tools.",
    ].join("\n");
}

/**
 * The directories the skills CLI treats as skill containers, mirroring its own priority list. It walks each one three
 * levels deep; a directory that does not exist is simply empty.
 */
const SKILL_CONTAINER_DIRS = [
    "skills",
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".github/skills",
    ".opencode/skills",
];

const SKILL_CONTAINER_DEPTH = 3;

export interface DiscoveredSkill {
    /** Repository-relative path of the SKILL.md. */
    path: string;
    /** Whether the skill opts out of discovery with `metadata.internal`. */
    internal: boolean;
}

/**
 * Whether a SKILL.md marks itself internal, which is how the skills CLI is told to keep it out of an install.
 */
export function isInternalSkill(content: string): boolean {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return false;
    return /^metadata:[ \t]*$[\s\S]*?^[ \t]+internal:[ \t]*true[ \t]*$/m.test(frontmatter[1]);
}

/**
 * Reports skills that an installer would be offered but that this repository never meant to publish.
 */
export function findUnpublishedSkills(discovered: DiscoveredSkill[], publishedPaths: string[]): string[] {
    const published = new Set(publishedPaths);
    return discovered
        .filter((skill) => !published.has(skill.path) && !skill.internal)
        .map((skill) => skill.path);
}

export function formatUnpublishedSkills(paths: string[]): string {
    return [
        "Skills that this repository does not publish are still offered to anyone who installs from it:",
        ...paths.map((path) => `- ${path}`),
        "",
        "Add it to scripts/skill-sync-baseline.json to publish it, or keep it for this repository only by adding",
        "a `metadata:` block with `internal: true` to its front matter.",
    ].join("\n");
}

/**
 * Finds every SKILL.md the skills CLI would offer to someone installing from the repository at `rootPath`.
 */
export async function discoverSkillsInContainers(rootPath: string): Promise<DiscoveredSkill[]> {
    const discovered: DiscoveredSkill[] = [];

    const walk = async (relativeDir: string, depth: number): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
            entries = await Array.fromAsync(await fsReaddir(`${rootPath}/${relativeDir}`, { withFileTypes: true }));
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory()) continue;
            const childDir = `${relativeDir}/${entry.name}`;
            const skillPath = `${childDir}/SKILL.md`;
            let content: string;
            try {
                content = await fsReadFile(`${rootPath}/${skillPath}`, "utf8");
            } catch {
                if (depth < SKILL_CONTAINER_DEPTH) await walk(childDir, depth + 1);
                continue;
            }
            // The CLI stops descending below a skill it found, so a nested SKILL.md is never offered.
            discovered.push({ path: skillPath, internal: isInternalSkill(content) });
        }
    };

    for (const container of SKILL_CONTAINER_DIRS) await walk(container, 1);
    return discovered;
}

/**
 * Every Markdown file a published skill ships, read from disk: its SKILL.md first, then the rest in path order.
 *
 * The list comes from the directory rather than from the baseline on purpose. A hand-maintained list would leave the
 * same hole one level up, where a file nobody registered is a file nobody scans.
 */
export async function collectPublishedSkillFiles(rootPath: string, skillPath: string): Promise<string[]> {
    const skillDir = skillPath.slice(0, skillPath.lastIndexOf("/"));
    const support: string[] = [];

    const walk = async (relativeDir: string): Promise<void> => {
        const entries = await Array.fromAsync(await fsReaddir(`${rootPath}/${relativeDir}`, { withFileTypes: true }));
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const path = `${relativeDir}/${entry.name}`;
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith(".md") && path !== skillPath) support.push(path);
        }
    };

    await walk(skillDir);
    return [skillPath, ...support];
}

async function hashFile(relativePath: string): Promise<string> {
    const content = await fsReadFile(new URL(relativePath, REPO_ROOT));
    const digest = await crypto.subtle.digest("SHA-256", content);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuilds each recorded entry from the files on disk, discovering support files rather than trusting the baseline.
 */
export async function readCurrentSkills(skills: PublishedSkill[]): Promise<PublishedSkill[]> {
    return await Promise.all(skills.map(async (entry) => {
        const [, ...supportPaths] = await collectPublishedSkillFiles(REPO_ROOT_PATH, entry.skill);
        const supportFiles = await Promise.all(
            supportPaths.map(async (path) => ({ path, hash: await hashFile(path) })),
        );
        const current: PublishedSkill = {
            skill: entry.skill,
            skillHash: await hashFile(entry.skill),
            supportFiles,
        };
        if (entry.source !== undefined) {
            current.source = entry.source;
            current.sourceHash = await hashFile(entry.source);
        }
        return current;
    }));
}

async function readBaseline(): Promise<SkillSyncBaseline> {
    const parsed = JSON.parse(await fsReadFile(BASELINE_PATH, "utf8"));
    if (!parsed || !Array.isArray(parsed.skills)) {
        throw new Error("skill-sync-baseline.json must contain a `skills` array");
    }
    return parsed;
}

/** Orders each entry's keys so an updated baseline stays readable and diffs stay small. */
function forBaselineFile(entry: PublishedSkill): PublishedSkill {
    return {
        ...(entry.source === undefined ? {} : { source: entry.source, sourceHash: entry.sourceHash }),
        skill: entry.skill,
        skillHash: entry.skillHash,
        supportFiles: entry.supportFiles,
    };
}

if (import.meta.main) {
    const baseline = await readBaseline();
    const current = await readCurrentSkills(baseline.skills);

    if (process.argv.slice(2).includes("--update")) {
        const skills = current.map(forBaselineFile);
        await fsWriteFile(BASELINE_PATH, `${JSON.stringify({ skills }, null, 4)}\n`);
        console.log("Updated scripts/skill-sync-baseline.json.");
        process.exit(0);
    }

    const leaks: ProjectSpecificLeak[] = [];
    for (const entry of current) {
        for (const path of [entry.skill, ...entry.supportFiles.map((file) => file.path)]) {
            leaks.push(...findProjectSpecificLeaks(path, await fsReadFile(new URL(path, REPO_ROOT), "utf8")));
        }
    }
    if (leaks.length > 0) {
        console.error(formatLeaks(leaks));
        process.exit(1);
    }

    const unpublished = findUnpublishedSkills(
        await discoverSkillsInContainers(REPO_ROOT_PATH),
        baseline.skills.map((entry) => entry.skill),
    );
    if (unpublished.length > 0) {
        console.error(formatUnpublishedSkills(unpublished));
        process.exit(1);
    }

    const drift = findSkillSyncDrift(baseline.skills, current);
    if (drift.length > 0) {
        console.error(formatDrift(drift));
        process.exit(1);
    }

    console.log(`Skill sync baseline matches ${baseline.skills.length} published skills.`);
}
