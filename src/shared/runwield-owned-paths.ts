import { join } from "@std/path";
import {
    PLAN_BACKUPS_DIR_NAME,
    PLAN_LOCKS_DIR_NAME,
    PLAN_STAGING_DIR_NAME,
    PLAN_TRANSITIONS_DIR_NAME,
    PROJECT_INTERNAL_RUNTIME_DIR_NAME,
    PROJECT_SECRET_STORE_RELATIVE_PATH,
    RUNWIELD_DIR_NAME,
    WORKTREE_REGISTRY_FILE,
    WORKTREE_REGISTRY_LOCK_FILE,
} from "../constants.js";

export interface RunWieldGitignoreWarning {
    kind: "broad_wld_ignore" | "unmatched_managed_marker";
    message: string;
    rule?: string;
}

export interface RunWieldGitignoreReconciliationResult {
    warnings: RunWieldGitignoreWarning[];
    changed: boolean;
}

function underRunWield(name: string): string {
    return `${RUNWIELD_DIR_NAME}/${name}`;
}

const CURRENT_RUNTIME_ROOT = underRunWield(PROJECT_INTERNAL_RUNTIME_DIR_NAME);

const LEGACY_RUNTIME_DIRECTORIES = [
    underRunWield(PLAN_LOCKS_DIR_NAME),
    underRunWield(PLAN_TRANSITIONS_DIR_NAME),
    underRunWield(PLAN_BACKUPS_DIR_NAME),
    underRunWield(PLAN_STAGING_DIR_NAME),
    underRunWield("worktrees"),
    underRunWield("debug"),
    underRunWield("controller"),
];

const LEGACY_RUNTIME_FILES = [
    underRunWield(WORKTREE_REGISTRY_FILE),
    underRunWield(WORKTREE_REGISTRY_LOCK_FILE),
    underRunWield("worktree-registry-migration-issues.json"),
    PROJECT_SECRET_STORE_RELATIVE_PATH,
    underRunWield("work-record-supersession.lock"),
    underRunWield("work-record-supersession-recovery.lock"),
];

const LEGACY_RUNTIME_TEMP_FILE_PATTERNS = [
    `${underRunWield(WORKTREE_REGISTRY_FILE)}.*.tmp`,
    `${PROJECT_SECRET_STORE_RELATIVE_PATH}.*.tmp`,
];

export const CURRENT_PROJECT_RUNTIME_PATHS = Object.freeze([CURRENT_RUNTIME_ROOT]);
export const LEGACY_PROJECT_RUNTIME_HAZARD_PATHS = Object.freeze([
    ...LEGACY_RUNTIME_DIRECTORIES,
    ...LEGACY_RUNTIME_FILES,
    ...LEGACY_RUNTIME_TEMP_FILE_PATTERNS,
]);
export const RUNWIELD_OWNED_RUNTIME_PATHS = Object.freeze([
    ...CURRENT_PROJECT_RUNTIME_PATHS,
    ...LEGACY_PROJECT_RUNTIME_HAZARD_PATHS,
]);

function normalizeGitPath(path: string): string {
    return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

function isAtomicTempPath(path: string, filePath: string): boolean {
    const prefix = `${filePath}.`;
    const suffix = ".tmp";
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
    const token = path.slice(prefix.length, -suffix.length);
    return token.length > 0 && !token.includes("/");
}

function isLegacyRuntimeTempPath(path: string): boolean {
    return isAtomicTempPath(path, underRunWield(WORKTREE_REGISTRY_FILE)) ||
        isAtomicTempPath(path, PROJECT_SECRET_STORE_RELATIVE_PATH);
}

export function isCurrentProjectRuntimePath(path: string): boolean {
    const normalized = normalizeGitPath(path);
    return normalized === CURRENT_RUNTIME_ROOT || normalized.startsWith(`${CURRENT_RUNTIME_ROOT}/`);
}

export function isLegacyProjectRuntimeHazardPath(path: string): boolean {
    const normalized = normalizeGitPath(path);
    if (!normalized || normalized === RUNWIELD_DIR_NAME || isCurrentProjectRuntimePath(normalized)) return false;
    if (isLegacyRuntimeTempPath(normalized)) return true;
    for (const dir of LEGACY_RUNTIME_DIRECTORIES) {
        if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
    }
    return LEGACY_RUNTIME_FILES.some((file) => normalized === file);
}

export function isRunWieldOwnedRuntimePath(path: string): boolean {
    return isCurrentProjectRuntimePath(path) || isLegacyProjectRuntimeHazardPath(path);
}

export const runwieldOwnedPathspecExclusions = Object.freeze(
    RUNWIELD_OWNED_RUNTIME_PATHS.map((path) => {
        const isDirectory = CURRENT_PROJECT_RUNTIME_PATHS.includes(path) || LEGACY_RUNTIME_DIRECTORIES.includes(path);
        return `:(exclude)${path}${isDirectory ? "/**" : ""}`;
    }),
);

const GITIGNORE_START = "# BEGIN RunWield owned runtime state";
const GITIGNORE_END = "# END RunWield owned runtime state";

export const RUNWIELD_GITIGNORE_BLOCK = `${GITIGNORE_START}\n${CURRENT_RUNTIME_ROOT}/\n${GITIGNORE_END}\n`;

const OBSOLETE_GITIGNORE_LINES = new Set([
    ...LEGACY_RUNTIME_DIRECTORIES.flatMap((path) => [path, `${path}/`]),
    ...LEGACY_RUNTIME_FILES,
    ...LEGACY_RUNTIME_TEMP_FILE_PATTERNS,
]);

interface GitignoreLine {
    text: string;
    eol: string;
}

function splitLines(input: string): GitignoreLine[] {
    const matches = input.match(/.*(?:\r\n|\n|\r)|.+$/g) || [];
    return matches.map((line) => {
        const eol = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : line.endsWith("\r") ? "\r" : "";
        return { text: eol ? line.slice(0, -eol.length) : line, eol };
    });
}

function preferredEol(input: string): string {
    return input.includes("\r\n") ? "\r\n" : "\n";
}

function canonicalBlock(eol: string, retainedLegacyDirectories: string[] = []): string {
    return [
        GITIGNORE_START,
        `${CURRENT_RUNTIME_ROOT}/`,
        ...retainedLegacyDirectories.map((path) => `${path}/`),
        GITIGNORE_END,
        "",
    ].join(eol);
}

function isBroadRunWieldIgnoreRule(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
    return trimmed === ".wld" || trimmed === ".wld/" || trimmed === "/.wld" || trimmed === "/.wld/" ||
        trimmed === ".wld/**" || trimmed === "/.wld/**";
}

function isObsoleteRunWieldLine(line: string): boolean {
    if (!line || line.startsWith("#") || line.startsWith("!")) return false;
    return OBSOLETE_GITIGNORE_LINES.has(line);
}

export function analyzeRunWieldGitignore(existing: string): RunWieldGitignoreWarning[] {
    return reconcileGitignore(existing).warnings;
}

export async function inspectRunWieldGitignore(projectRoot: string): Promise<RunWieldGitignoreWarning[]> {
    try {
        return analyzeRunWieldGitignore(await Deno.readTextFile(join(projectRoot, ".gitignore")));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
    }
}

/** True when `ensureRunWieldOwnedGitignoreBlock` would add or rewrite the managed block. Reads only. */
export async function runWieldGitignoreNeedsUpdate(projectRoot: string): Promise<boolean> {
    let existing = "";
    try {
        existing = await Deno.readTextFile(join(projectRoot, ".gitignore"));
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return reconcileGitignore(existing).content !== existing;
}

function reconcileGitignore(
    existing: string,
    retainedLegacyDirectories: string[] = [],
): { content: string; warnings: RunWieldGitignoreWarning[] } {
    const eol = preferredEol(existing);
    const lines = splitLines(existing);
    const warnings: RunWieldGitignoreWarning[] = [];
    const kept: GitignoreLine[] = [];
    let insertedBlock = false;
    let removedManagedBlock = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.text === GITIGNORE_START) {
            let endIndex = -1;
            for (let candidateIndex = index + 1; candidateIndex < lines.length; candidateIndex++) {
                const candidate = lines[candidateIndex];
                if (candidate.text === GITIGNORE_START) break;
                if (candidate.text === GITIGNORE_END) {
                    endIndex = candidateIndex;
                    break;
                }
            }
            if (endIndex === -1) {
                warnings.push({
                    kind: "unmatched_managed_marker",
                    message: "RunWield found an unmatched .gitignore managed-block marker and left it unchanged.",
                });
                kept.push(line);
                continue;
            }
            if (!insertedBlock) {
                kept.push(...splitLines(canonicalBlock(eol, retainedLegacyDirectories)));
                insertedBlock = true;
            }
            removedManagedBlock = true;
            index = endIndex;
            continue;
        }
        if (line.text === GITIGNORE_END) {
            warnings.push({
                kind: "unmatched_managed_marker",
                message: "RunWield found an unmatched .gitignore managed-block marker and left it unchanged.",
            });
            kept.push(line);
            continue;
        }
        if (isBroadRunWieldIgnoreRule(line.text)) {
            warnings.push({
                kind: "broad_wld_ignore",
                rule: line.text.trim(),
                message:
                    `The .gitignore rule ${line.text.trim()} also hides .wld/settings.json, .wld/agents/, .wld/skills/, and .wld/prompts/ from Git.`,
            });
            kept.push(line);
            continue;
        }
        if (isObsoleteRunWieldLine(line.text)) continue;
        kept.push(line);
    }
    if (!insertedBlock) {
        if (kept.length > 0 && kept[kept.length - 1].eol === "") kept[kept.length - 1].eol = eol;
        kept.push(...splitLines(canonicalBlock(eol, retainedLegacyDirectories)));
    }
    const content = kept.map((line) => `${line.text}${line.eol}`).join("");
    if (!removedManagedBlock && existing === "") {
        return { content: canonicalBlock(eol, retainedLegacyDirectories), warnings };
    }
    return { content, warnings };
}

/** Compare only the deterministic managed-rule update, preserving unrelated rules. */
export function isRunWieldOwnedGitignoreChange(before: string, after: string): boolean {
    return reconcileGitignore(before).content === reconcileGitignore(after).content;
}

export async function ensureRunWieldOwnedGitignoreBlock(
    projectRoot: string,
): Promise<RunWieldGitignoreReconciliationResult> {
    const gitignorePath = join(projectRoot, ".gitignore");
    let existing = "";
    try {
        existing = await Deno.readTextFile(gitignorePath);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // Publication clones and old-writer lock inodes may survive adoption. They
    // must never become user changes (or be accidentally committed with git add).
    const retainedLegacyDirectories: string[] = [];
    for (const path of LEGACY_RUNTIME_DIRECTORIES) {
        const exists = await Deno.lstat(join(projectRoot, path)).then(() => true).catch((error) => {
            if (error instanceof Deno.errors.NotFound) return false;
            throw error;
        });
        if (exists) retainedLegacyDirectories.push(path);
    }
    const { content, warnings } = reconcileGitignore(existing, retainedLegacyDirectories);
    const changed = content !== existing;
    if (changed) await Deno.writeTextFile(gitignorePath, content);
    return { warnings, changed };
}
