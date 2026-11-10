import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
/**
 * @module shared/session/agents
 * Agent discovery — scans agent definitions (bundled + overrides) and returns merged metadata.
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { extractYaml, test as hasFrontMatter, type FrontMatterRecord, type FrontMatterValue } from "../front-matter.ts";
import { AGENT_DEFS_DIR, AGENTS, SYSTEM_PROMPT_TEMPLATE_PATH } from "../../constants.js";
import { directoryExists, fileExists } from "../helpers.ts";
import {
    assertPersonalResourcePath,
    assertPersonalResourcePathSync,
    personalGlobalRoot,
    PersonalResourcePathError,
} from "../remote/personal-resources.ts";
import {
    AGENT_TOOL_SETS,
    DELEGATE_AGENT_MODE_TOOL_NAMES,
    PROTECTED_TOOL_NAMES,
    UNIVERSAL_AGENT_TOOL_NAMES,
} from "../../tools/registry.ts";
import { normalizeBashAllowedCommands, type BashAllowedCommands } from "../bash-command-policy.ts";
import type { DelegationMode } from "../../tools/delegate-agent.ts";

type AgentContextContract = "quick-fix" | "plan-execution" | "frontend-plan-execution" | "validation-repair";

export type AgentDefinition = {
    /** Agent name from frontmatter or the filename. */
    name: string;
    displayName: string;
    model: string;
    /** One-line description from merged frontmatter. */
    description: string;
    /** Declared execution context from merged frontmatter. Runtime authority is resolved separately. */
    contextContract?: AgentContextContract;
    /** Allowed tool names from merged frontmatter. */
    tools: string[];
    /** Allowed delegate_agent modes. Absent allows every mode. */
    delegationModes?: DelegationMode[];
    /** Restricted RunWield shell selectors. Absent allows all commands. */
    bashAllowedCommands?: readonly string[];
    /** Workflow-only Agents are hidden from listings and manual selection. */
    workflowOnly?: boolean;
    /** Active-Agent busy labels. Absent uses the default label. */
    busyLines?: readonly string[];
    /** Provider thinking or reasoning level. */
    thinkingLevel?: string;
    /** Provider temperature from frontmatter, between 0 and 2. */
    temperature?: number;
    /** Core system prompt and merged Agent prompt. */
    systemPrompt: string;
};

export type AgentRolePrompt = {
    /** Merged Agent prompt and shared practice, without the Core system prompt template. */
    rolePrompt: string;
};

/** An Agent definition loaded from its layered files. */
export type LoadedAgentDefinition = AgentDefinition & AgentRolePrompt;

export interface AgentDefinitionFrontMatter extends FrontMatterRecord {
    bashAllowedCommands?: BashAllowedCommands | null;
}

export interface AgentDiscovery {
    names: string[];
    /** Existing definition layers, lowest priority first. */
    layerDirs: string[];
}

export interface SharedPracticeDiscovery {
    /** Existing practice layers, highest priority first. */
    layerDirs: string[];
    /** Composed bodies for ordered normalized names. */
    prompts: Map<string, string>;
}

export interface ResolvedDelegationTools {
    /** Tool names with mode-limited delegation names folded into `delegate_agent`. */
    tools: string[];
    /** Allowed modes. An absent value allows all modes. */
    delegationModes: DelegationMode[] | undefined;
}

export interface LoadAgentDefFromPathOptions {
    /** Override the internal name, which defaults to the filename without `.md`. */
    agentName?: string;
}

type RawAgentField = FrontMatterValue | undefined;

function homeAgentDefsDir() {
    return join(personalGlobalRoot(), "agents");
}

export const __dirname = dirname(fromFileUrl(import.meta.url));

/**
 * Subdirectory holding shared practice fragments composed into agent prompts by
 * name. It is a subdirectory rather than a top-level file so `listAgentDefNames`
 * — which reads only top-level `.md` files — never mistakes a fragment for an agent.
 */
const SHARED_PRACTICE_DIR = "shared-practice";

const SHARED_PRACTICE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CONTEXT_CONTRACTS = Object.freeze([
    "quick-fix",
    "plan-execution",
    "frontend-plan-execution",
    "validation-repair",
]);

function getAgentDefLayerDirs(projectRoot: string | undefined): string[] {
    return [
        AGENT_DEFS_DIR,
        ...(homeAgentDefsDir() ? [homeAgentDefsDir()] : []),
        ...(projectRoot ? [join(projectRoot, ".wld", "agents")] : []),
    ];
}

function getAgentDefDirsByPriority(projectRoot: string | undefined): string[] {
    return [
        ...(projectRoot ? [join(projectRoot, ".wld", "agents")] : []),
        ...(homeAgentDefsDir() ? [homeAgentDefsDir()] : []),
        AGENT_DEFS_DIR,
    ];
}

/**
 * Resolve an existing agent definitions directory for pi-coding-agent resource loading.
 * Priority: local (`.wld/agents`) > home (`~/.wld/agents`) > bundled defaults.
 */
export async function resolveAgentDefsDir(projectRoot?: string) {
    const localAgentDefsDir = projectRoot ? join(projectRoot, ".wld", "agents") : null;
    for (const dir of getAgentDefDirsByPriority(projectRoot)) {
        await assertPersonalResourcePath(dir, "Agent definitions directory");
        if (await directoryExists(dir)) return dir;
    }

    throw new Error(
        [
            "Could not find any agent defs directory.",
            ...(localAgentDefsDir ? [`Tried local: ${localAgentDefsDir}`] : []),
            ...(homeAgentDefsDir() ? [`Tried home: ${homeAgentDefsDir()}`] : []),
            `Tried bundled: ${AGENT_DEFS_DIR}`,
        ].join(" "),
    );
}

/**
 * Sync cache of display names keyed by internal agent name (filename without .md).
 * Populated as a side-effect of every `loadAgentDef*` call so callers that need a
 * display name without awaiting (for example footer rendering) can resolve one cheaply.
 */
const displayNameCache = new Map<string, string>();

/**
 * Sync cache of busy indicator lines keyed by internal agent name. Populated as
 * a side-effect of every `loadAgentDef*` call so callers that need busy lines
 * without awaiting (for example runtime event emission) can resolve them cheaply.
 */
const busyLinesCache = new Map<string, readonly string[]>();

const AGENT_INTERNAL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize an Agent identity to its canonical filename-derived form. Display
 * names come only from frontmatter and must never be used as Runtime identity.
 */
export function normalizeAgentInternalName(internalName: string) {
    const canonicalName = internalName.trim().toLowerCase();
    if (!AGENT_INTERNAL_NAME_PATTERN.test(canonicalName)) {
        throw new Error(`Invalid agent internal name: ${JSON.stringify(internalName)}`);
    }
    return canonicalName;
}

function displayNameCacheKey(projectRoot: string | undefined, internalName: string) {
    return `${projectRoot}\0${internalName}`;
}

/**
 * Synchronously read an agent file's frontmatter `name:` field. Used by
 * `getAgentDisplayName` when the cache is cold. The frontmatter is the only
 * source of truth — we never synthesize a display name from the internal name.
 */
function readDisplayNameFromFrontMatterSync(internalName: string, projectRoot: string | undefined) {
    const candidatePaths = getAgentDefDirsByPriority(projectRoot).map((dir) => join(dir, `${internalName}.md`));

    for (const filePath of candidatePaths) {
        let raw;
        try {
            assertPersonalResourcePathSync(filePath, "Agent display name");
            raw = readFileSync(filePath, "utf8");
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            continue;
        }
        if (!hasFrontMatter(raw)) continue;
        const { attrs } = extractYaml(raw);
        const name = attrs.name;
        if (typeof name === "string" && name.trim()) {
            return name.trim();
        }
    }

    return null;
}

/**
 * Resolve an agent's display name from its definition's frontmatter `name:`
 * field. The cache is populated by `loadAgentDef*`; on miss, the file is read
 * synchronously so the frontmatter remains the single source of truth.
 *
 * Throws when the agent definition cannot be located or has no `name:` field —
 * silently inventing a display name would hide misconfiguration.
 */
export function getAgentDisplayName(internalName: string, projectRoot?: string) {
    if (!internalName) {
        throw new Error("getAgentDisplayName: internalName is required");
    }
    const canonicalName = normalizeAgentInternalName(internalName);
    const cacheKey = displayNameCacheKey(projectRoot, canonicalName);
    const cached = displayNameCache.get(cacheKey);
    if (cached) return cached;

    const fromFile = readDisplayNameFromFrontMatterSync(canonicalName, projectRoot);
    if (fromFile) {
        displayNameCache.set(cacheKey, fromFile);
        return fromFile;
    }

    // Workflow-only subagent definitions live outside the top-level agent files,
    // which the layered lookup above deliberately does not search — they must
    // stay out of `/agent` listings. Their display names are pinned here instead.
    const workflowOnlyDisplayName = {
        [AGENTS.SLICER]: "Slicer",
        [AGENTS.REVIEWER_FEEDBACK_ENGINEER]: "Validation Repair Engineer",
    }[canonicalName];
    if (workflowOnlyDisplayName) {
        displayNameCache.set(cacheKey, workflowOnlyDisplayName);
        return workflowOnlyDisplayName;
    }

    throw new Error(
        `getAgentDisplayName: no agent definition with a frontmatter "name:" field was found for "${canonicalName}". ` +
            `Searched: ${getAgentDefDirsByPriority(projectRoot)
                .map((dir) => join(dir, `${canonicalName}.md`))
                .join(", ")}.`,
    );
}

/**
 * Synchronously read an agent file's frontmatter `busyLines:` field across all
 * definition layers (highest priority wins). Returns `undefined` when no valid
 * entry is found — the caller falls back to the default "Working...".
 */
function readBusyLinesFromFrontMatterSync(
    internalName: string,
    projectRoot: string | undefined,
): readonly string[] | undefined {
    const candidatePaths = getAgentDefDirsByPriority(projectRoot).map((dir) => join(dir, `${internalName}.md`));

    for (const filePath of candidatePaths) {
        let raw;
        try {
            assertPersonalResourcePathSync(filePath, "Agent busy lines");
            raw = readFileSync(filePath, "utf8");
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            continue;
        }
        if (!hasFrontMatter(raw)) continue;
        const { attrs } = extractYaml(raw);
        const lines = normalizeBusyLines(attrs.busyLines);
        if (lines) return lines;
    }

    return undefined;
}

/**
 * Resolve an agent's busy indicator lines from its definition's frontmatter
 * `busyLines:` field. The cache is populated by `loadAgentDef*`; on miss, the
 * file is read synchronously. Returns `undefined` when no busy lines are
 * declared — callers should fall back to "Working...".
 */
export function getAgentBusyLines(internalName: string, projectRoot?: string): readonly string[] | undefined {
    if (!internalName) return undefined;
    const canonicalName = normalizeAgentInternalName(internalName);
    const cacheKey = displayNameCacheKey(projectRoot, canonicalName);
    const cached = busyLinesCache.get(cacheKey);
    if (cached) return cached;
    const fromFile = readBusyLinesFromFrontMatterSync(canonicalName, projectRoot);
    if (fromFile) {
        busyLinesCache.set(cacheKey, fromFile);
        return fromFile;
    }
    return undefined;
}

/**
 * List all known agent definition names across bundled + home + local layers.
 */
export async function listAgentDefNames(projectRoot?: string) {
    return (await discoverAgentDefinitions(projectRoot)).names;
}

/**
 * Scan each layer once. Absent layers stay absent for this discovery only.
 */
async function discoverAgentDefinitions(projectRoot: string | undefined): Promise<AgentDiscovery> {
    const names = new Set<string>();
    const layerDirs = [];

    for (const dir of getAgentDefLayerDirs(projectRoot)) {
        await assertPersonalResourcePath(dir, "Agent definitions directory");
        if (!(await directoryExists(dir))) continue;
        layerDirs.push(dir);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
            await assertPersonalResourcePath(join(dir, entry.name), "Agent definition");
            const fileName = entry.name.replace(/\.md$/, "");
            const canonicalName = normalizeAgentInternalName(fileName);
            if (fileName !== canonicalName) {
                throw new Error(
                    `Agent definition filename must be canonical lowercase: ${entry.name} (expected ${canonicalName}.md)`,
                );
            }
            names.add(canonicalName);
        }
    }

    return { names: [...names].sort((a, b) => a.localeCompare(b)), layerDirs };
}

/**
 * Normalize unknown tool list input into a deduped array of non-empty strings.
 */
function normalizeToolNames(tools: unknown): string[] {
    if (!Array.isArray(tools)) return [];

    const normalized: string[] = [];

    for (const tool of tools) {
        const toolName = typeof tool === "string" ? tool.trim() : "";
        if (!toolName) continue;
        if (!normalized.includes(toolName)) normalized.push(toolName);
    }

    return normalized;
}

/**
 * Expand `toolSets` front matter into the tool names of each named set.
 * Unknown names fail so a typo can't silently drop an Agent's tools.
 */
function expandToolSets(value: RawAgentField, source: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
        throw new Error(`${source}: toolSets must be a list of set names.`);
    }
    return value.flatMap((name) => {
        const setName = name.trim();
        if (!Object.hasOwn(AGENT_TOOL_SETS, setName)) {
            throw new Error(
                `${source}: unknown toolSets entry "${name}". Expected one of: ${Object.keys(AGENT_TOOL_SETS).join(", ")}.`,
            );
        }
        return AGENT_TOOL_SETS[setName];
    });
}

/**
 * Normalize the `busyLines` front matter value into a readonly string array.
 * Valid entries are non-empty strings; anything else is filtered out.
 * Returns `undefined` when no valid entries exist.
 */
function normalizeBusyLines(value: RawAgentField): readonly string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const lines = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return lines.length > 0 ? lines : undefined;
}

function normalizeTemperature(value: RawAgentField) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value < 0 || value > 2) return undefined;
    return value;
}

function normalizeContextContract(value: RawAgentField, agentName: string): AgentDefinition["contextContract"] {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !CONTEXT_CONTRACTS.includes(value)) {
        throw new Error(
            `Agent def "${agentName}" declares invalid contextContract: ${JSON.stringify(value)}. ` +
                `Expected one of: ${CONTEXT_CONTRACTS.join(", ")}.`,
        );
    }
    return value as AgentContextContract;
}

/**
 * Resolve final requested tool names for a session while enforcing agent policy.
 *
 * - `toolNames` may narrow the agent's tool set but cannot add tools outside `agentTools`.
 * - `customToolNames` are always added (for user-provided dynamic/extension tools).
 */
export function resolveSessionToolNames(agentTools: string[], toolNames: unknown, customToolNames: unknown): string[] {
    const normalizedAgentTools = normalizeToolNames(agentTools);
    const selectedToolNames = normalizeToolNames(toolNames || normalizedAgentTools);
    const normalizedCustomToolNames = normalizeToolNames(customToolNames);
    const allowedToolNames = new Set(normalizedAgentTools);
    const universalAgentToolNames = normalizedAgentTools.filter((toolName) =>
        UNIVERSAL_AGENT_TOOL_NAMES.includes(toolName),
    );

    const tools: string[] = [];
    for (const toolName of selectedToolNames) {
        if (!allowedToolNames.has(toolName)) continue;
        if (!tools.includes(toolName)) tools.push(toolName);
    }
    for (const toolName of universalAgentToolNames) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }
    for (const toolName of normalizedCustomToolNames) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }

    return tools;
}

/**
 * List every merged agent definition, including the workflow-only ones. Callers
 * that offer the user a choice want `listAvailableAgents` instead.
 */
export async function listAllAgentDefinitions(projectRoot?: string): Promise<AgentDefinition[]> {
    const { names, layerDirs } = await discoverAgentDefinitions(projectRoot);
    const practiceLayerDirs = [];
    for (const dir of [...layerDirs].reverse()) {
        const practiceDir = join(dir, SHARED_PRACTICE_DIR);
        await assertPersonalResourcePath(practiceDir, "Shared practice directory");
        if (await directoryExists(practiceDir)) practiceLayerDirs.push(dir);
    }

    const sharedPractice: SharedPracticeDiscovery = { layerDirs: practiceLayerDirs, prompts: new Map() };

    const agents: AgentDefinition[] = [];

    for (const name of names) {
        try {
            const def = await loadNamedAgentDef(name, projectRoot, layerDirs, sharedPractice);
            agents.push(def);
        } catch (err) {
            if (err instanceof PersonalResourcePathError) throw err;
            // Surface malformed agent definitions instead of silently dropping them.
            console.error(`[RunWield] Skipping agent "${name}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    agents.sort((agentA, agentB) => agentA.name.localeCompare(agentB.name));

    return agents;
}

/**
 * List the agent definitions a user may select. Workflow-only Agents are
 * omitted: an approved Plan activates them, so offering them as a manual choice
 * would promise an identity the user cannot actually take on.
 */
export async function listAvailableAgents(projectRoot?: string): Promise<AgentDefinition[]> {
    const agents = await listAllAgentDefinitions(projectRoot);
    return agents.filter((agent) => !agent.workflowOnly);
}

/**
 * Whether a named Agent exists but is workflow-only, so an explicit `/agent`
 * request for it should be explained rather than treated as an unknown name.
 */
export async function isWorkflowOnlyAgent(agentName: string, projectRoot?: string) {
    let canonicalName;
    try {
        canonicalName = normalizeAgentInternalName(agentName);
    } catch {
        return false;
    }
    try {
        const def = await loadAgentDef(canonicalName, projectRoot);
        return def.workflowOnly === true;
    } catch (error) {
        if (error instanceof PersonalResourcePathError) throw error;
        return false;
    }
}

/**
 * Explain why an existing Agent cannot be entered by hand.
 */
export function buildWorkflowOnlyAgentMessage(agentName: string, projectRoot?: string) {
    const displayName = getAgentDisplayName(agentName, projectRoot);
    return (
        `${displayName} is activated by RunWield as part of a workflow, not by hand. ` +
        `Staying with the current agent.`
    );
}

/**
 * Normalize the `sharedPractice:` front matter field into fragment names.
 */
function normalizeSharedPracticeNames(value: RawAgentField, agentName: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Agent def "${agentName}" has a non-list sharedPractice field`);
    }

    const names: string[] = [];
    for (const entry of value) {
        const name = typeof entry === "string" ? entry.trim() : "";
        if (!name) continue;
        if (!SHARED_PRACTICE_NAME_PATTERN.test(name)) {
            throw new Error(
                `Agent def "${agentName}" requests an invalid shared practice name: ${JSON.stringify(entry)}`,
            );
        }
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * Read a shared practice fragment body, resolved through the same layer priority
 * as agent definitions so a project or home layer can override bundled practice.
 *
 * @param layerDirs - Highest priority first
 */
async function readSharedPracticeBody(name: string, layerDirs: string[]) {
    const candidatePaths = layerDirs.map((dir) => join(dir, SHARED_PRACTICE_DIR, `${name}.md`));

    for (const filePath of candidatePaths) {
        await assertPersonalResourcePath(filePath, `shared practice "${name}"`);
        if (!(await fileExists(filePath))) continue;
        const raw = await readFile(filePath, "utf8");
        if (!hasFrontMatter(raw)) {
            throw new Error(`Shared practice fragment ${filePath} has no frontmatter`);
        }
        const body = extractYaml(raw).body.trim();
        if (!body) throw new Error(`Shared practice fragment is empty: ${filePath}`);
        return body;
    }

    throw new Error(`Could not find shared practice fragment "${name}". Checked: ${candidatePaths.join(", ")}`);
}

/**
 * Compose named shared-practice fragments for full agents and bare-prompt
 * subagents. Keeping this path common prevents workflow-only agents from
 * silently missing universal collaboration policy.
 */
export async function composeSharedPracticePrompt(value: RawAgentField, agentName: string, projectRoot?: string) {
    return await composeSharedPracticeNames(
        normalizeSharedPracticeNames(value, agentName),
        getAgentDefDirsByPriority(projectRoot),
    );
}

/**
 * @param layerDirs - Highest priority first
 */
async function composeSharedPracticeNames(names: string[], layerDirs: string[]) {
    const segments = [];
    for (const name of names) {
        segments.push(await readSharedPracticeBody(name, layerDirs));
    }
    return segments.join("\n\n").trim();
}

/**
 * Cache only successful compositions, within one discovery. Validate each
 * definition before lookup, so malformed declarations still name their owner.
 */
async function composeDiscoveredSharedPractice(
    value: RawAgentField,
    agentName: string,
    discovery: SharedPracticeDiscovery,
) {
    const names = normalizeSharedPracticeNames(value, agentName);
    const key = JSON.stringify(names);
    const cached = discovery.prompts.get(key);
    if (cached !== undefined) return cached;
    const prompt = await composeSharedPracticeNames(names, discovery.layerDirs);
    discovery.prompts.set(key, prompt);
    return prompt;
}

/**
 * Load and merge an agent definition from one or more layered files in priority
 * order (lowest → highest). Missing paths are skipped; if none exist, throws.
 *
 * Higher layers override scalar attrs. Prompt body appends by default; if a
 * layer sets `promptOverride: true`, lower-layer prompt content is discarded.
 * Fragments named by the merged `sharedPractice:` list are appended last, so an
 * agent prompt reads persona → process → universal practice.
 * Tool lists are replaced when a higher layer defines `tools` or `toolSets`;
 * that layer's list is its expanded sets followed by its `tools`. Tools declared
 * in the lowest existing layer are treated as "bundled" for protected-tool
 * enforcement (always re-added even if a higher layer narrows the list).
 *
 * @param agentName - the file name to load (without .md)
 * @param filePaths - Paths to attempt, ordered low → high priority
 */
async function loadAgentDefFromPaths(
    agentName: string,
    filePaths: string[],
    projectRoot: string | undefined,
    sharedPractice?: SharedPracticeDiscovery,
): Promise<LoadedAgentDefinition> {
    let mergedAttrs: AgentDefinitionFrontMatter = {};

    let mergedTools: string[] = [];

    let bundledTools: string[] = [];
    let bundledToolsSet = false;

    let promptSegments: string[] = [];
    let found = false;

    for (const filePath of filePaths) {
        await assertPersonalResourcePath(filePath, `Agent definition "${agentName}"`);
        if (!(await fileExists(filePath))) continue;

        const raw = await readFile(filePath, "utf8");
        if (!hasFrontMatter(raw)) {
            throw new Error(`Agent def ${filePath} has no frontmatter`);
        }

        const { attrs, body } = extractYaml<AgentDefinitionFrontMatter>(raw);
        if (Object.hasOwn(attrs, "bashAllowedCommands")) {
            const commands = normalizeBashAllowedCommands(attrs.bashAllowedCommands, filePath);
            const inherited = mergedAttrs.bashAllowedCommands;
            attrs.bashAllowedCommands = commands?.length
                ? [...new Set([...(Array.isArray(inherited) ? inherited : []), ...commands])]
                : commands;
        }
        found = true;

        if (Object.hasOwn(attrs, "tools") || Object.hasOwn(attrs, "toolSets")) {
            const normalized = normalizeToolNames([
                ...expandToolSets(attrs.toolSets, filePath),
                ...normalizeToolNames(attrs.tools),
            ]);
            if (!bundledToolsSet) {
                bundledTools = normalized;
                bundledToolsSet = true;
            }
            mergedTools = normalized;
        }

        mergedAttrs = { ...mergedAttrs, ...attrs };

        if (attrs.promptOverride === true) {
            promptSegments = [];
        }

        const trimmedBody = body.trim();
        if (trimmedBody) promptSegments.push(trimmedBody);
    }

    if (!found) {
        throw new Error(`Could not find agent def for "${agentName}". Checked: ${filePaths.join(", ")}`);
    }

    const displayName =
        typeof mergedAttrs.name === "string" && mergedAttrs.name.trim() ? mergedAttrs.name.trim() : agentName;
    const model = typeof mergedAttrs.model === "string" && mergedAttrs.model.trim() ? mergedAttrs.model.trim() : "";
    const description = typeof mergedAttrs.description === "string" ? mergedAttrs.description.trim() : "";
    const thinkingLevel =
        typeof mergedAttrs.thinkingLevel === "string" &&
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(mergedAttrs.thinkingLevel)
            ? mergedAttrs.thinkingLevel
            : undefined;
    const temperature = normalizeTemperature(mergedAttrs.temperature);
    const contextContract = normalizeContextContract(mergedAttrs.contextContract, agentName);
    // Merged, so a project or home layer can mark its own Agent workflow-only —
    // or unhide a bundled one. The flag controls discoverability only; workflow
    // dispatch loads and activates the exact Agent identity either way.
    const workflowOnly = mergedAttrs.workflowOnly === true;
    const busyLines = normalizeBusyLines(mergedAttrs.busyLines);
    const bashAllowedCommands = normalizeBashAllowedCommands(
        mergedAttrs.bashAllowedCommands,
        `Agent definition "${agentName}"`,
    );

    const sharedPracticePrompt = sharedPractice
        ? await composeDiscoveredSharedPractice(mergedAttrs.sharedPractice, agentName, sharedPractice)
        : await composeSharedPracticePrompt(mergedAttrs.sharedPractice, agentName, projectRoot);
    if (sharedPracticePrompt) promptSegments.push(sharedPracticePrompt);

    const mergedPromptBody = promptSegments.join("\n\n").trim();
    const CORE_SYSTEM_PROMPT = await readFile(SYSTEM_PROMPT_TEMPLATE_PATH, "utf8");
    const systemPrompt = CORE_SYSTEM_PROMPT.replace("{{AGENT_PROMPT}}", mergedPromptBody);

    const protectedToolsForAgent = bundledTools.filter((toolName) => PROTECTED_TOOL_NAMES.includes(toolName));
    const tools = [...mergedTools];
    for (const toolName of protectedToolsForAgent) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }

    const { tools: resolvedTools, delegationModes } = resolveDelegationModes(tools);

    displayNameCache.set(displayNameCacheKey(projectRoot, agentName), displayName);
    if (busyLines) busyLinesCache.set(displayNameCacheKey(projectRoot, agentName), busyLines);

    return {
        name: agentName,
        displayName,
        model,
        description,
        contextContract,
        thinkingLevel,
        temperature,
        tools: resolvedTools,
        delegationModes,
        bashAllowedCommands,
        workflowOnly,
        busyLines,
        systemPrompt,
        rolePrompt: mergedPromptBody,
    };
}

/**
 * Fold `delegate_agent_read` and `delegate_agent_write` into the one `delegate_agent` tool and record which modes
 * they allow. Plain `delegate_agent` keeps every mode.
 */
function resolveDelegationModes(tools: string[]): ResolvedDelegationTools {
    const modes: DelegationMode[] = [];

    const resolved: string[] = [];
    for (const toolName of tools) {
        const mode = Object.hasOwn(DELEGATE_AGENT_MODE_TOOL_NAMES, toolName)
            ? DELEGATE_AGENT_MODE_TOOL_NAMES[toolName as keyof typeof DELEGATE_AGENT_MODE_TOOL_NAMES]
            : undefined;
        if (mode && !modes.includes(mode)) modes.push(mode);
        const name = mode ? "delegate_agent" : toolName;
        if (!resolved.includes(name)) resolved.push(name);
    }
    const unlimited = tools.includes("delegate_agent") || !modes.length;
    return { tools: resolved, delegationModes: unlimited ? undefined : modes };
}

function addUniversalAgentTools(agentDef: LoadedAgentDefinition): LoadedAgentDefinition {
    const tools = [...agentDef.tools];
    for (const toolName of UNIVERSAL_AGENT_TOOL_NAMES) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }
    return { ...agentDef, tools };
}

/**
 * Load and merge an agent definition by name from layered files:
 * 1) bundled: `src/agent-definitions/<name>.md`
 * 2) home override: `~/.wld/agents/<name>.md`
 * 3) local override: `<cwd>/.wld/agents/<name>.md`
 */
export async function loadAgentDef(agentName: string, projectRoot?: string): Promise<LoadedAgentDefinition> {
    return await loadNamedAgentDef(agentName, projectRoot, getAgentDefLayerDirs(projectRoot));
}

/**
 * Own the ordered paths for both discovery and individual loads, including the
 * workflow-only bundled repair definition. Public loaders always read fresh.
 *
 * @param layerDirs - Lowest priority first
 */
async function loadNamedAgentDef(
    agentName: string,
    projectRoot: string | undefined,
    layerDirs: string[],
    sharedPractice?: SharedPracticeDiscovery,
): Promise<LoadedAgentDefinition> {
    const canonicalName = normalizeAgentInternalName(agentName);
    const filePaths = layerDirs.map((dir) => join(dir, `${canonicalName}.md`));
    if (canonicalName === AGENTS.REVIEWER_FEEDBACK_ENGINEER) {
        filePaths.splice(1, 0, join(AGENT_DEFS_DIR, "subagent-definitions", `${canonicalName}.md`));
    }

    return addUniversalAgentTools(await loadAgentDefFromPaths(canonicalName, filePaths, projectRoot, sharedPractice));
}

/**
 * Load an agent definition from an arbitrary file path.
 * Used for special agents (like init) that live outside the standard
 * agent-defs directories and should not be discoverable via /agent listings.
 *
 * @param filePath - Absolute path to the agent .md file
 */
export function loadAgentDefFromPath(
    filePath: string,
    options?: LoadAgentDefFromPathOptions,
): Promise<LoadedAgentDefinition> {
    const agentName = normalizeAgentInternalName(options?.agentName || basename(filePath, ".md"));
    return loadAgentDefFromPaths(agentName, [filePath], dirname(filePath));
}
