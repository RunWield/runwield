/** @typedef {import("../front-matter.ts").FrontMatterRecord & { bashAllowedCommands?: import("../bash-command-policy.ts").BashAllowedCommands | null }} AgentDefinitionFrontMatter */
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
/**
 * @module shared/session/agents
 * Agent discovery — scans agent definitions (bundled + overrides) and returns merged metadata.
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { extractYaml, test as hasFrontMatter } from "../front-matter.ts";
import { AGENT_DEFS_DIR, AGENTS, SYSTEM_PROMPT_TEMPLATE_PATH } from "../../constants.js";
import { directoryExists, fileExists } from "../helpers.ts";
import {
    assertPersonalResourcePath,
    assertPersonalResourcePathSync,
    personalGlobalRoot,
    PersonalResourcePathError,
} from "../remote/personal-resources.ts";
import { AGENT_TOOL_SETS, PROTECTED_TOOL_NAMES, UNIVERSAL_AGENT_TOOL_NAMES } from "../../tools/registry.ts";
import { normalizeBashAllowedCommands } from "../bash-command-policy.ts";

/** @returns {string | null} */
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

export const ATTENTION_NUDGE_TURN_INTERVAL = 6;

export const _AGENT_ATTENTION_NUDGES = {
    [AGENTS.GUIDE]:
        "You are still the Guide. Answer direct questions concisely from durable project evidence with compact citations, separate intent from verified outcomes/current behavior, use docs-only Markdown tools only after explicit preservation requests, and state the concrete limit and offer `/agent` options for code/config edits, workflow artifacts, plans, execution, or deeper ideation.",
    [AGENTS.IDEATOR]:
        "You are still the Ideator. Stay at problem and product altitude: investigate feasibility, surface overlooked consequences, prioritize consequential divergent decisions, infer low-risk solution details, batch minor preferences when input is truly needed, and state the concrete limit and offer `/agent` options for actionable implementation or planning requests.",
    [AGENTS.PLANNER]:
        "You are still the Planner. Keep refining the plan file iteratively, ask only blocking questions, and call `plan_written` with the plan name without `.md` when the plan is ready.",
    [AGENTS.ARCHITECT]:
        "You are still the Architect. Stress-test assumptions, resolve architectural decisions, write ADRs only when justified, and leave task slicing to the Slicer.",
    [AGENTS.SLICER]:
        "You are still the Slicer. Keep the conversation scoped to this Epic decomposition: propose child Planned Change boundaries, use Slicer workflow tools only when explicitly asked, and finalize only after explicit user confirmation.",
    [AGENTS.ENGINEER]:
        "You are still the Engineer working a bounded QUICK_FIX. The request in front of you is the boundary: keep to its elastic edges, load the Skills and documentation the work needs instead of improvising, verify with the project's own command, and call `task_completed` when the work is done so Mechanical Validation can run. If something blocks you, say what stopped you in plain text and do not call `task_completed`. If the work grows into design or architecture, name the `/agent` that owns it once and follow the user's answer.",
    [AGENTS.PLAN_ENGINEER]:
        "You are still the Plan Engineer executing the approved Plan. Work its Implementation Steps in order, run the Verification Plan before you report, and never edit the Plan on your own or to match what you built. If the user explicitly directs an active-Plan revision, raise at most one concern, then make the exact edit and continue when they repeat the direction. If something blocks you, name the step and the contradicting fact in plain text instead of calling `task_completed`.",
    [AGENTS.FRONTEND_ENGINEER]:
        "You are still the Frontend Engineer executing the approved Plan. Work its Implementation Steps in order, keep the dev server and headed browser session live, verify the visible result in the real browser before you report, and never edit the Plan on your own or to match what you built. If the user explicitly directs an active-Plan revision, raise at most one concern, then make the exact edit and continue when they repeat the direction. If something blocks you, say what stopped you in plain text instead of calling `task_completed`.",
};

/**
 * @param {string | undefined} projectRoot
 * @returns {string[]}
 */
function getAgentDefLayerDirs(projectRoot) {
    return [
        AGENT_DEFS_DIR,
        ...(homeAgentDefsDir() ? [/** @type {string} */ (homeAgentDefsDir())] : []),
        ...(projectRoot ? [join(projectRoot, ".wld", "agents")] : []),
    ];
}

/**
 * @param {string | undefined} projectRoot
 * @returns {string[]}
 */
function getAgentDefDirsByPriority(projectRoot) {
    return [
        ...(projectRoot ? [join(projectRoot, ".wld", "agents")] : []),
        ...(homeAgentDefsDir() ? [/** @type {string} */ (homeAgentDefsDir())] : []),
        AGENT_DEFS_DIR,
    ];
}

/**
 * Resolve an existing agent definitions directory for pi-coding-agent resource loading.
 * Priority: local (`.wld/agents`) > home (`~/.wld/agents`) > bundled defaults.
 *
 * @param {string} [projectRoot]
 * @returns {Promise<string>}
 */
export async function resolveAgentDefsDir(projectRoot) {
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
 *
 * @type {Map<string, string>}
 */
const displayNameCache = new Map();

/**
 * Sync cache of busy indicator lines keyed by internal agent name. Populated as
 * a side-effect of every `loadAgentDef*` call so callers that need busy lines
 * without awaiting (for example runtime event emission) can resolve them cheaply.
 *
 * @type {Map<string, readonly string[]>}
 */
const busyLinesCache = new Map();

const AGENT_INTERNAL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize an Agent identity to its canonical filename-derived form. Display
 * names come only from frontmatter and must never be used as Runtime identity.
 *
 * @param {string} internalName
 * @returns {string}
 */
export function normalizeAgentInternalName(internalName) {
    const canonicalName = internalName.trim().toLowerCase();
    if (!AGENT_INTERNAL_NAME_PATTERN.test(canonicalName)) {
        throw new Error(`Invalid agent internal name: ${JSON.stringify(internalName)}`);
    }
    return canonicalName;
}

/**
 * @param {string | undefined} projectRoot
 * @param {string} internalName
 * @returns {string}
 */
function displayNameCacheKey(projectRoot, internalName) {
    return `${projectRoot}\0${internalName}`;
}

/**
 * Synchronously read an agent file's frontmatter `name:` field. Used by
 * `getAgentDisplayName` when the cache is cold. The frontmatter is the only
 * source of truth — we never synthesize a display name from the internal name.
 *
 * @param {string} internalName
 * @param {string | undefined} projectRoot
 * @returns {string | null}
 */
function readDisplayNameFromFrontMatterSync(internalName, projectRoot) {
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
        const name = /** @type {{ name?: unknown }} */ (attrs).name;
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
 *
 * @param {string} internalName
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function getAgentDisplayName(internalName, projectRoot) {
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
 *
 * @param {string} internalName
 * @param {string | undefined} projectRoot
 * @returns {readonly string[] | undefined}
 */
function readBusyLinesFromFrontMatterSync(internalName, projectRoot) {
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
        const lines = normalizeBusyLines(/** @type {{ busyLines?: unknown }} */ (attrs).busyLines);
        if (lines) return lines;
    }

    return undefined;
}

/**
 * Resolve an agent's busy indicator lines from its definition's frontmatter
 * `busyLines:` field. The cache is populated by `loadAgentDef*`; on miss, the
 * file is read synchronously. Returns `undefined` when no busy lines are
 * declared — callers should fall back to "Working...".
 *
 * @param {string} internalName
 * @param {string} [projectRoot]
 * @returns {readonly string[] | undefined}
 */
export function getAgentBusyLines(internalName, projectRoot) {
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
 *
 * @param {string} [projectRoot]
 * @returns {Promise<string[]>}
 */
export async function listAgentDefNames(projectRoot) {
    const names = new Set();

    for (const dir of getAgentDefLayerDirs(projectRoot)) {
        await assertPersonalResourcePath(dir, "Agent definitions directory");
        if (!(await directoryExists(dir))) continue;
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

    return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Normalize unknown tool list input into a deduped array of non-empty strings.
 *
 * @param {unknown} tools
 * @returns {string[]}
 */
function normalizeToolNames(tools) {
    if (!Array.isArray(tools)) return [];

    /** @type {string[]} */
    const normalized = [];

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
 *
 * @param {unknown} value
 * @param {string} source
 * @returns {string[]}
 */
function expandToolSets(value, source) {
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
 * @param {unknown} value
 * @returns {number | undefined}
 */
/**
 * Normalize the `busyLines` front matter value into a readonly string array.
 * Valid entries are non-empty strings; anything else is filtered out.
 * Returns `undefined` when no valid entries exist.
 *
 * @param {unknown} value
 * @returns {readonly string[] | undefined}
 */
function normalizeBusyLines(value) {
    if (!Array.isArray(value)) return undefined;
    const lines = value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return lines.length > 0 ? lines : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function normalizeTemperature(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value < 0 || value > 2) return undefined;
    return value;
}

/**
 * @param {unknown} value
 * @param {string} agentName
 * @returns {import('./types.js').AgentDefinition['contextContract']}
 */
function normalizeContextContract(value, agentName) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !CONTEXT_CONTRACTS.includes(value)) {
        throw new Error(
            `Agent def "${agentName}" declares invalid contextContract: ${JSON.stringify(value)}. ` +
                `Expected one of: ${CONTEXT_CONTRACTS.join(", ")}.`,
        );
    }
    return /** @type {import('./types.js').AgentDefinition['contextContract']} */ (value);
}

/**
 * Resolve final requested tool names for a session while enforcing agent policy.
 *
 * - `toolNames` may narrow the agent's tool set but cannot add tools outside `agentTools`.
 * - `customToolNames` are always added (for user-provided dynamic/extension tools).
 *
 * @param {string[]} agentTools
 * @param {unknown} toolNames
 * @param {unknown} customToolNames
 * @returns {string[]}
 */
export function resolveSessionToolNames(agentTools, toolNames, customToolNames) {
    const normalizedAgentTools = normalizeToolNames(agentTools);
    const selectedToolNames = normalizeToolNames(toolNames || normalizedAgentTools);
    const normalizedCustomToolNames = normalizeToolNames(customToolNames);
    const allowedToolNames = new Set(normalizedAgentTools);
    const universalAgentToolNames = normalizedAgentTools.filter((toolName) =>
        UNIVERSAL_AGENT_TOOL_NAMES.includes(toolName),
    );

    /** @type {string[]} */
    const tools = [];
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
 *
 * @param {string} [projectRoot]
 * @returns {Promise<import('./types.js').AgentDefinition[]>}
 */
export async function listAllAgentDefinitions(projectRoot) {
    const names = await listAgentDefNames(projectRoot);
    /** @type {import('./types.js').AgentDefinition[]} */
    const agents = [];

    for (const name of names) {
        try {
            const def = await loadAgentDef(name, projectRoot);
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
 *
 * @param {string} [projectRoot]
 * @returns {Promise<import('./types.js').AgentDefinition[]>}
 */
export async function listAvailableAgents(projectRoot) {
    const agents = await listAllAgentDefinitions(projectRoot);
    return agents.filter((agent) => !agent.workflowOnly);
}

/**
 * Whether a named Agent exists but is workflow-only, so an explicit `/agent`
 * request for it should be explained rather than treated as an unknown name.
 *
 * @param {string} agentName
 * @param {string} [projectRoot]
 * @returns {Promise<boolean>}
 */
export async function isWorkflowOnlyAgent(agentName, projectRoot) {
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
 *
 * @param {string} agentName
 * @param {string} [projectRoot]
 * @returns {string}
 */
export function buildWorkflowOnlyAgentMessage(agentName, projectRoot) {
    const displayName = getAgentDisplayName(agentName, projectRoot);
    return (
        `${displayName} is activated by RunWield as part of a workflow, not by hand. ` +
        `Staying with the current agent.`
    );
}

/**
 * Normalize the `sharedPractice:` front matter field into fragment names.
 *
 * @param {unknown} value
 * @param {string} agentName
 * @returns {string[]}
 */
function normalizeSharedPracticeNames(value, agentName) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new Error(`Agent def "${agentName}" has a non-list sharedPractice field`);
    }

    /** @type {string[]} */
    const names = [];
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
 * @param {string} name
 * @param {string | undefined} projectRoot
 * @returns {Promise<string>}
 */
async function readSharedPracticeBody(name, projectRoot) {
    const candidatePaths = getAgentDefDirsByPriority(projectRoot).map((dir) =>
        join(dir, SHARED_PRACTICE_DIR, `${name}.md`),
    );

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
 *
 * @param {unknown} value
 * @param {string} agentName
 * @param {string | undefined} [projectRoot]
 * @returns {Promise<string>}
 */
export async function composeSharedPracticePrompt(value, agentName, projectRoot) {
    const segments = [];
    for (const name of normalizeSharedPracticeNames(value, agentName)) {
        segments.push(await readSharedPracticeBody(name, projectRoot));
    }
    return segments.join("\n\n").trim();
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
 * @param {string} agentName - the file name to load (without .md)
 * @param {string[]} filePaths - Paths to attempt, ordered low → high priority
 * @param {string | undefined} projectRoot
 * @returns {Promise<import('./types.js').AgentDefinition>}
 */
async function loadAgentDefFromPaths(agentName, filePaths, projectRoot) {
    /** @type {{ name?: string, model?: string, description?: string, contextContract?: unknown, promptOverride?: boolean, thinkingLevel?: string, temperature?: unknown, tools?: unknown[], busyLines?: unknown, [key: string]: unknown }} */
    let mergedAttrs = {};
    /** @type {string[]} */
    let mergedTools = [];
    /** @type {string[]} */
    let bundledTools = [];
    let bundledToolsSet = false;
    /** @type {string[]} */
    let promptSegments = [];
    let found = false;

    for (const filePath of filePaths) {
        await assertPersonalResourcePath(filePath, `Agent definition "${agentName}"`);
        if (!(await fileExists(filePath))) continue;

        const raw = await readFile(filePath, "utf8");
        if (!hasFrontMatter(raw)) {
            throw new Error(`Agent def ${filePath} has no frontmatter`);
        }

        const { attrs, body } = /** @type {import("../front-matter.ts").FrontMatter<AgentDefinitionFrontMatter>} */ (
            extractYaml(raw)
        );
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
        /** @type {string[] | null | undefined} */ (mergedAttrs.bashAllowedCommands),
        `Agent definition "${agentName}"`,
    );

    const sharedPracticePrompt = await composeSharedPracticePrompt(mergedAttrs.sharedPractice, agentName, projectRoot);
    if (sharedPracticePrompt) promptSegments.push(sharedPracticePrompt);

    const mergedPromptBody = promptSegments.join("\n\n").trim();
    const CORE_SYSTEM_PROMPT = await readFile(SYSTEM_PROMPT_TEMPLATE_PATH, "utf8");
    const systemPrompt = CORE_SYSTEM_PROMPT.replace("{{AGENT_PROMPT}}", mergedPromptBody);

    const protectedToolsForAgent = bundledTools.filter((toolName) => PROTECTED_TOOL_NAMES.includes(toolName));
    const tools = [...mergedTools];
    for (const toolName of protectedToolsForAgent) {
        if (!tools.includes(toolName)) tools.push(toolName);
    }

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
        tools,
        bashAllowedCommands,
        workflowOnly,
        busyLines,
        systemPrompt,
    };
}

/**
 * @param {import('./types.js').AgentDefinition} agentDef
 * @returns {import('./types.js').AgentDefinition}
 */
function addUniversalAgentTools(agentDef) {
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
 *
 * @param {string} agentName
 * @param {string} [projectRoot]
 * @returns {Promise<import('./types.js').AgentDefinition>}
 */
export async function loadAgentDef(agentName, projectRoot) {
    const canonicalName = normalizeAgentInternalName(agentName);
    const filePaths = getAgentDefLayerDirs(projectRoot).map((dir) => join(dir, `${canonicalName}.md`));
    if (canonicalName === AGENTS.REVIEWER_FEEDBACK_ENGINEER) {
        filePaths.splice(1, 0, join(AGENT_DEFS_DIR, "subagent-definitions", `${canonicalName}.md`));
    }

    return addUniversalAgentTools(await loadAgentDefFromPaths(canonicalName, filePaths, projectRoot));
}

/**
 * Load an agent definition from an arbitrary file path.
 * Used for special agents (like init) that live outside the standard
 * agent-defs directories and should not be discoverable via /agent listings.
 *
 * @param {string} filePath - Absolute path to the agent .md file
 * @param {{ agentName?: string }} [options] - Override the internal name used as the cache key
 *   (defaults to the file's basename without `.md`).
 * @returns {Promise<import('./types.js').AgentDefinition>}
 */
export function loadAgentDefFromPath(filePath, options) {
    const agentName = normalizeAgentInternalName(options?.agentName || basename(filePath, ".md"));
    return loadAgentDefFromPaths(agentName, [filePath], dirname(filePath));
}
