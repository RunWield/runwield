import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DelegationMode } from "@runwield/tools";
import { normalizeBashAllowedCommands, type BashAllowedCommands } from "@runwield/parsing/shell-selectors";
import {
    extractYaml,
    test as hasFrontMatter,
    type FrontMatterRecord,
    type FrontMatterValue,
} from "@runwield/parsing/front-matter";
import {
    assertPersonalResourcePath,
    assertPersonalResourcePathSync,
    PersonalResourcePathError,
    remotePersonalResourcesActive,
} from "@runwield/resources/personal";
import {
    BUNDLED_DEFINITIONS_DIR,
    personalDefinitionsDir,
    projectDefinitionsDir,
    SYSTEM_PROMPT_TEMPLATE_PATH,
} from "./locations.ts";
import { addUniversalTools, expandToolSets, normalizeToolNames, resolveRoleTools, selectTools } from "./tool-policy.ts";
import { AGENTS } from "./role-ids.ts";

export type AgentContextContract = "quick-fix" | "plan-execution" | "frontend-plan-execution" | "validation-repair";

export type AgentDefinition = {
    /** Canonical role identifier. */
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

interface AgentDefinitionFrontMatter extends FrontMatterRecord {
    bashAllowedCommands?: BashAllowedCommands | null;
}

interface DefinitionScope {
    projectRoot: string | undefined;
    personalDir: string;
}

interface AgentDiscovery {
    names: string[];
    /** Existing definition layers, lowest priority first. */
    layerDirs: string[];
}

interface SharedPracticeDiscovery {
    /** Existing practice layers, highest priority first. */
    layerDirs: string[];
    /** Composed bodies for ordered normalized names. */
    prompts: Map<string, string>;
}

interface LoadAgentDefFromPathOptions {
    /** Override the internal name, which defaults to the filename without `.md`. */
    agentName?: string;
}

type RawAgentField = FrontMatterValue | undefined;

export type AgentVisibility = "selectable" | "all";

/** Shared practice fragments are kept below the definitions scanned for `listNames`. */
const SHARED_PRACTICE_DIR = "shared-practice";

const SHARED_PRACTICE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CONTEXT_CONTRACTS = Object.freeze([
    "quick-fix",
    "plan-execution",
    "frontend-plan-execution",
    "validation-repair",
]);

const AGENT_INTERNAL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize an Agent identity to its canonical filename-derived form. Display
 * names come only from frontmatter and must never be used as Runtime identity.
 */
function normalizeName(internalName: string) {
    const canonicalName = internalName.trim().toLowerCase();
    if (!AGENT_INTERNAL_NAME_PATTERN.test(canonicalName)) {
        throw new Error(`Invalid agent internal name: ${JSON.stringify(internalName)}`);
    }
    return canonicalName;
}

function metadataCacheKey(scope: DefinitionScope, internalName: string) {
    return JSON.stringify([scope.projectRoot, scope.personalDir, internalName]);
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

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

export function createRoleRegistry() {
    function definitionScope(projectRoot: string | undefined): DefinitionScope {
        return { projectRoot, personalDir: personalDefinitionsDir() };
    }

    function getAgentDefLayerDirs({ projectRoot, personalDir }: DefinitionScope): string[] {
        return [BUNDLED_DEFINITIONS_DIR, personalDir, ...(projectRoot ? [projectDefinitionsDir(projectRoot)] : [])];
    }

    function getAgentDefDirsByPriority(scope: DefinitionScope): string[] {
        return getAgentDefLayerDirs(scope).reverse();
    }

    /**
     * Sync cache of display names keyed by internal agent name (filename without .md).
     * Populated as a side-effect of every `get*` call so callers that need a
     * display name without awaiting (for example footer rendering) can resolve one cheaply.
     */
    const displayNameCache = new Map<string, string>();

    /**
     * Sync cache of busy indicator lines keyed by internal agent name. Populated as
     * a side-effect of every `get*` call so callers that need busy lines
     * without awaiting (for example runtime event emission) can resolve them cheaply.
     */
    const busyLinesCache = new Map<string, readonly string[] | undefined>();

    /**
     * Synchronously read an agent file's frontmatter `name:` field. Used by
     * `displayName` when the cache is cold. The frontmatter is the only
     * source of truth — we never synthesize a display name from the internal name.
     */
    function readDisplayNameFromFrontMatterSync(candidatePaths: string[]) {
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
     * field. The cache is populated by `get*`; on miss, the file is read
     * synchronously so the frontmatter remains the single source of truth.
     *
     * Throws when the agent definition cannot be located or has no `name:` field —
     * silently inventing a display name would hide misconfiguration.
     */
    function displayName(internalName: string, projectRoot?: string) {
        if (!internalName) {
            throw new Error("getAgentDisplayName: internalName is required");
        }
        const canonicalName = normalizeName(internalName);
        const scope = definitionScope(projectRoot);
        const cacheKey = metadataCacheKey(scope, canonicalName);
        const cached = displayNameCache.get(cacheKey);
        if (cached) {
            assertCachedPresentationAccess(scope, canonicalName, "Agent display name");
            return cached;
        }

        const candidatePaths = getAgentDefDirsByPriority(scope).map((dir) => join(dir, `${canonicalName}.md`));
        const fromFile = readDisplayNameFromFrontMatterSync(candidatePaths);
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
                `Searched: ${candidatePaths.join(", ")}.`,
        );
    }

    /**
     * Synchronously read an agent file's frontmatter `busyLines:` field across all
     * definition layers (highest priority wins). Returns `undefined` when no valid
     * entry is found — the caller falls back to the default "Working...".
     */
    function readBusyLinesFromFrontMatterSync(
        internalName: string,
        scope: DefinitionScope,
    ): readonly string[] | undefined {
        const candidatePaths = getAgentDefDirsByPriority(scope).map((dir) => join(dir, `${internalName}.md`));

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
     * `busyLines:` field. The cache is populated by `get*`; on miss, the
     * file is read synchronously. Returns `undefined` when no busy lines are
     * declared — callers should fall back to "Working...".
     */
    function busyLines(internalName: string, projectRoot?: string): readonly string[] | undefined {
        if (!internalName) return undefined;
        const canonicalName = normalizeName(internalName);
        const scope = definitionScope(projectRoot);
        const cacheKey = metadataCacheKey(scope, canonicalName);
        if (busyLinesCache.has(cacheKey)) {
            assertCachedPresentationAccess(scope, canonicalName, "Agent busy lines");
            return busyLinesCache.get(cacheKey);
        }
        const fromFile = readBusyLinesFromFrontMatterSync(canonicalName, scope);
        if (fromFile) {
            busyLinesCache.set(cacheKey, fromFile);
            return fromFile;
        }
        return undefined;
    }

    function assertCachedPresentationAccess(scope: DefinitionScope, name: string, purpose: string): void {
        if (!remotePersonalResourcesActive()) return;
        for (const dir of getAgentDefLayerDirs(scope)) {
            assertPersonalResourcePathSync(join(dir, `${name}.md`), purpose);
        }
    }

    /**
     * List all known agent definition names across bundled + home + local layers.
     */
    async function listNames(projectRoot?: string) {
        return (await discoverAgentDefinitions(definitionScope(projectRoot))).names;
    }

    /**
     * Scan each layer once. Absent layers stay absent for this discovery only.
     */
    async function discoverAgentDefinitions(scope: DefinitionScope): Promise<AgentDiscovery> {
        const names = new Set<string>();
        const layerDirs = [];

        for (const dir of getAgentDefLayerDirs(scope)) {
            await assertPersonalResourcePath(dir, "Agent definitions directory");
            if (!(await isDirectory(dir))) continue;
            layerDirs.push(dir);
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
                await assertPersonalResourcePath(join(dir, entry.name), "Agent definition");
                const fileName = entry.name.replace(/\.md$/, "");
                const canonicalName = normalizeName(fileName);
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

    /** Load the merged definitions, hiding workflow-only roles unless requested. */
    async function list(
        projectRoot?: string,
        visibility: AgentVisibility = "selectable",
    ): Promise<LoadedAgentDefinition[]> {
        const scope = definitionScope(projectRoot);
        const { names, layerDirs } = await discoverAgentDefinitions(scope);
        const practiceLayerDirs = [];
        for (const dir of [...layerDirs].reverse()) {
            const practiceDir = join(dir, SHARED_PRACTICE_DIR);
            await assertPersonalResourcePath(practiceDir, "Shared practice directory");
            if (await isDirectory(practiceDir)) practiceLayerDirs.push(dir);
        }

        const sharedPractice: SharedPracticeDiscovery = { layerDirs: practiceLayerDirs, prompts: new Map() };

        const agents: LoadedAgentDefinition[] = [];

        for (const name of names) {
            try {
                const def = await loadNamedRole(name, scope, layerDirs, sharedPractice);
                agents.push(def);
            } catch (err) {
                if (err instanceof PersonalResourcePathError) throw err;
                // Surface malformed agent definitions instead of silently dropping them.
                console.error(
                    `[RunWield] Skipping agent "${name}": ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        agents.sort((agentA, agentB) => agentA.name.localeCompare(agentB.name));

        return visibility === "all" ? agents : agents.filter((agent) => !agent.workflowOnly);
    }

    /** Check whether the named role can only be selected by a workflow. */
    async function isWorkflowOnly(agentName: string, projectRoot?: string) {
        let canonicalName;
        try {
            canonicalName = normalizeName(agentName);
        } catch {
            return false;
        }
        try {
            const def = await get(canonicalName, projectRoot);
            return def.workflowOnly === true;
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            return false;
        }
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
            if (!(await isFile(filePath))) continue;
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
    async function composeSharedPractice(value: RawAgentField, agentName: string, projectRoot?: string) {
        return await composeSharedPracticeNames(
            normalizeSharedPracticeNames(value, agentName),
            getAgentDefDirsByPriority(definitionScope(projectRoot)),
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
    async function loadPaths(
        agentName: string,
        filePaths: string[],
        scope: DefinitionScope,
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
            if (!(await isFile(filePath))) continue;

            const raw = await readFile(filePath, "utf8");
            if (!hasFrontMatter(raw)) {
                if (!found) throw new Error(`Agent def ${filePath} has no frontmatter`);
                const prompt = raw.trim();
                if (prompt) promptSegments.push(prompt);
                continue;
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
            : await composeSharedPracticeNames(
                  normalizeSharedPracticeNames(mergedAttrs.sharedPractice, agentName),
                  getAgentDefDirsByPriority(scope),
              );
        if (sharedPracticePrompt) promptSegments.push(sharedPracticePrompt);

        const mergedPromptBody = promptSegments.join("\n\n").trim();
        const coreSystemPrompt = await readFile(SYSTEM_PROMPT_TEMPLATE_PATH, "utf8");
        const systemPrompt = coreSystemPrompt.replace("{{AGENT_PROMPT}}", mergedPromptBody);

        const { tools, delegationModes } = resolveRoleTools(mergedTools, bundledTools);

        const cacheKey = metadataCacheKey(scope, agentName);
        displayNameCache.set(cacheKey, displayName);
        busyLinesCache.set(cacheKey, busyLines);

        return {
            name: agentName,
            displayName,
            model,
            description,
            contextContract,
            thinkingLevel,
            temperature,
            tools,
            delegationModes,
            bashAllowedCommands,
            workflowOnly,
            busyLines,
            systemPrompt,
            rolePrompt: mergedPromptBody,
        };
    }

    /**
     * Load and merge an agent definition by name from layered files:
     * 1) bundled: `definitions/<name>.md`
     * 2) home override: `~/.wld/agents/<name>.md`
     * 3) local override: `<cwd>/.wld/agents/<name>.md`
     */
    async function get(agentName: string, projectRoot?: string): Promise<LoadedAgentDefinition> {
        const scope = definitionScope(projectRoot);
        return await loadNamedRole(agentName, scope, getAgentDefLayerDirs(scope));
    }

    /**
     * Own the ordered paths for both discovery and individual loads, including the
     * workflow-only bundled repair definition. Public loaders always read fresh.
     *
     * @param layerDirs - Lowest priority first
     */
    async function loadNamedRole(
        agentName: string,
        scope: DefinitionScope,
        layerDirs: string[],
        sharedPractice?: SharedPracticeDiscovery,
    ): Promise<LoadedAgentDefinition> {
        const canonicalName = normalizeName(agentName);
        const filePaths = layerDirs.map((dir) => join(dir, `${canonicalName}.md`));
        if (canonicalName === AGENTS.REVIEWER_FEEDBACK_ENGINEER) {
            filePaths.splice(1, 0, join(BUNDLED_DEFINITIONS_DIR, "subagent-definitions", `${canonicalName}.md`));
        }

        const role = await loadPaths(canonicalName, filePaths, scope, sharedPractice);
        return { ...role, tools: addUniversalTools(role.tools) };
    }

    /**
     * Load a full isolated role such as Init from its bundled file.
     *
     * @param filePath - Absolute path to the agent .md file
     */
    function loadFromPath(filePath: string, options?: LoadAgentDefFromPathOptions): Promise<LoadedAgentDefinition> {
        const agentName = normalizeName(options?.agentName || basename(filePath, ".md"));
        return loadPaths(agentName, [filePath], definitionScope(dirname(filePath)));
    }

    return {
        busyLines,
        composeSharedPractice,
        displayName,
        get,
        isWorkflowOnly,
        list,
        listNames,
        loadFromPath,
        normalizeName,
        selectTools,
    };
}
