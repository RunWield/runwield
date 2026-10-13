import { readFile as fsReadFile } from "node:fs/promises";
/**
 * @module shared/session/subagent-definitions
 *
 * Typed loader for hidden workflow-dispatched subagent definitions.
 */

import { extractYaml } from "../front-matter.ts";
import { join } from "node:path";
import { AGENT_DEFS_DIR, AGENTS, SUBAGENTS } from "../../constants.js";
import { ensureBundledAgentDefFile } from "./agent-assets.ts";
import { composeSharedPracticePrompt, loadAgentDefFromPath } from "./agents.js";
import type { AgentDefinition } from "./types.js";
import { normalizeBashAllowedCommands } from "../bash-command-policy.ts";

const SUBAGENT_DEFINITIONS_DIR = "subagent-definitions";
const DELEGATED_ROLES_DIR = "roles";
const DELEGATED_PROMPT_FILE = "delegated-agent-prompt.md";
const DELEGATED_READ_PROMPT_FILE = "delegated-read-agent-prompt.md";
const INIT_PROMPT_FILE = "init-agent-prompt.md";
const MANUAL_QA_PROMPT_FILE = "manual-qa-prompt.md";
const REVIEWER_FEEDBACK_ENGINEER_FILE = "reviewer-feedback-engineer.md";
const REVIEWER_PROMPT_FILE = "reviewer-prompt.md";
const REVIEWER_VERIFY_PROMPT_FILE = "reviewer-verify-prompt.md";
const INTEGRATION_REVIEWER_PROMPT_FILE = "integration-reviewer-prompt.md";
const SLICER_PROMPT_FILE = "slicer-prompt.md";
const VERIFICATION_ADVERSARY_ROLE_FILE = "verification-adversary.md";

export type ReviewerSubAgentMode = "discovery" | "verify";
export type SubAgentDefinitionLoadMode = "barePrompt" | "fullAgent";
export type SubAgentDefinitionId = typeof SUBAGENTS[keyof typeof SUBAGENTS];

/** The most authority a delegated role may ever receive, regardless of the requested mode. */
export type DelegatedAuthority = "read" | "write";
export type DelegatedRoleId = "general" | "verification-adversary";

type PromptFrontMatterValue = string | number | boolean | string[] | null;
type PromptFrontMatterAttrs = Partial<Record<string, PromptFrontMatterValue>>;

export interface ParsedPromptFrontMatter {
    attrs: PromptFrontMatterAttrs;
    body: string;
}

export interface SubAgentDefinition {
    id: SubAgentDefinitionId;
    agentName: string;
    displayNameFallback: string;
    loadMode: SubAgentDefinitionLoadMode;
    file: string;
    verifyFile?: string;
    allowedTools?: readonly string[];
    /**
     * Explicit opt-out for a bare-prompt subagent that is intentionally
     * tool-free. A barePrompt definition must declare either `allowedTools`
     * (its canonical tool ceiling) or `toolFree: true`; anything else fails
     * closed at load time instead of silently running a session with no tools.
     */
    toolFree?: boolean;
}

export interface DelegatedRoleDefinition {
    id: DelegatedRoleId;
    /** Overlay appended to the base delegated prompt, or null for the unspecialized default. */
    overlayFile: string | null;
    authorityCeiling: DelegatedAuthority;
}

export interface LoadSubAgentDefinitionOptions {
    reviewerMode?: ReviewerSubAgentMode;
    delegatedRole?: DelegatedRoleId;
}

export const DELEGATED_READ_TOOLS = Object.freeze([
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "code_search",
    "code_show",
    "code_outline",
    "code_batch",
    "code_refs",
    "code_impact",
    "code_trace",
    "code_investigate",
    "code_structure",
    "code_impls",
    "code_importers",
    "web_search",
    "web_fetch",
    "web_code_search",
    "web_docs_search",
]);

export const DELEGATED_WRITE_TOOLS = Object.freeze([
    ...DELEGATED_READ_TOOLS,
    "edit",
    "write",
    "multi_file_edit",
    "create_image",
]);

export const REVIEWER_SUBAGENT_TOOLS = Object.freeze([
    "read",
    "grep",
    "find",
    "ls",
    "review_diff",
    "review_complete",
    "delegate_agent",
]);

/**
 * The Integration Reviewer reads selectively across a whole Epic, so its diff tool has no full-read gate and it is
 * expected to hand large areas to read-only delegates.
 */
export const INTEGRATION_REVIEWER_SUBAGENT_TOOLS = Object.freeze([
    "read",
    "grep",
    "find",
    "ls",
    "review_diff",
    "review_complete",
    "delegate_agent",
]);

export const SUBAGENT_DEFINITIONS: Readonly<Record<SubAgentDefinitionId, SubAgentDefinition>> = Object.freeze({
    [SUBAGENTS.DELEGATED]: Object.freeze({
        id: SUBAGENTS.DELEGATED,
        agentName: AGENTS.DELEGATED,
        displayNameFallback: "Delegated Agent",
        loadMode: "barePrompt",
        file: DELEGATED_PROMPT_FILE,
        allowedTools: DELEGATED_WRITE_TOOLS,
    }),
    [SUBAGENTS.DELEGATED_READ]: Object.freeze({
        id: SUBAGENTS.DELEGATED_READ,
        agentName: AGENTS.DELEGATED,
        displayNameFallback: "Delegated Agent",
        loadMode: "barePrompt",
        file: DELEGATED_READ_PROMPT_FILE,
        allowedTools: DELEGATED_READ_TOOLS,
    }),
    [SUBAGENTS.INIT]: Object.freeze({
        id: SUBAGENTS.INIT,
        agentName: AGENTS.INIT,
        displayNameFallback: "Init",
        loadMode: "fullAgent",
        file: INIT_PROMPT_FILE,
    }),
    [SUBAGENTS.MANUAL_QA]: Object.freeze({
        id: SUBAGENTS.MANUAL_QA,
        agentName: AGENTS.OPERATOR,
        displayNameFallback: "Manual QA",
        loadMode: "barePrompt",
        file: MANUAL_QA_PROMPT_FILE,
        allowedTools: Object.freeze(["qa_checklist_generated"]),
    }),
    [SUBAGENTS.REVIEWER]: Object.freeze({
        id: SUBAGENTS.REVIEWER,
        agentName: AGENTS.REVIEWER,
        displayNameFallback: "Reviewer",
        loadMode: "barePrompt",
        file: REVIEWER_PROMPT_FILE,
        verifyFile: REVIEWER_VERIFY_PROMPT_FILE,
        allowedTools: REVIEWER_SUBAGENT_TOOLS,
    }),
    [SUBAGENTS.INTEGRATION_REVIEWER]: Object.freeze({
        id: SUBAGENTS.INTEGRATION_REVIEWER,
        agentName: AGENTS.REVIEWER,
        displayNameFallback: "Integration Reviewer",
        loadMode: "barePrompt",
        file: INTEGRATION_REVIEWER_PROMPT_FILE,
        allowedTools: INTEGRATION_REVIEWER_SUBAGENT_TOOLS,
    }),
    [SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER]: Object.freeze({
        id: SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER,
        agentName: AGENTS.REVIEWER_FEEDBACK_ENGINEER,
        displayNameFallback: "Reviewer-Feedback Engineer",
        loadMode: "fullAgent",
        file: REVIEWER_FEEDBACK_ENGINEER_FILE,
    }),
    [SUBAGENTS.SLICER]: Object.freeze({
        id: SUBAGENTS.SLICER,
        agentName: AGENTS.SLICER,
        displayNameFallback: "Slicer",
        loadMode: "fullAgent",
        file: SLICER_PROMPT_FILE,
    }),
});

export const DELEGATED_ROLE_GENERAL: DelegatedRoleId = "general";

export const DELEGATED_ROLES: Readonly<Record<DelegatedRoleId, DelegatedRoleDefinition>> = Object.freeze({
    general: Object.freeze({
        id: "general",
        overlayFile: null,
        authorityCeiling: "write",
    }),
    "verification-adversary": Object.freeze({
        id: "verification-adversary",
        overlayFile: VERIFICATION_ADVERSARY_ROLE_FILE,
        authorityCeiling: "read",
    }),
});

export const DELEGATED_ROLE_IDS: readonly DelegatedRoleId[] = Object.freeze(
    Object.keys(DELEGATED_ROLES) as DelegatedRoleId[],
);

/** Resolves a caller-supplied role name, returning null when the role is not registered. */
export function getDelegatedRole(role: string | undefined | null): DelegatedRoleDefinition | null {
    if (role === undefined || role === null || role === "") return DELEGATED_ROLES[DELEGATED_ROLE_GENERAL];
    return Object.hasOwn(DELEGATED_ROLES, role) ? DELEGATED_ROLES[role as DelegatedRoleId] : null;
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecoverableBundledPromptReadError(error: Error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ||
        (error instanceof TypeError && /Unexpected end of input|Prompt file was empty/i.test(error.message)) ||
        error.message.startsWith("Bundled agent asset is missing:");
}

function normalizeBundledPromptFrontMatter(parsed: ParsedPromptFrontMatter): ParsedPromptFrontMatter {
    const sourceAttrs = parsed.attrs && typeof parsed.attrs === "object" ? parsed.attrs : {};
    const attrs: PromptFrontMatterAttrs = {};
    for (const [key, value] of Object.entries(sourceAttrs)) {
        if (
            typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ||
            (Array.isArray(value) && value.every((item) => typeof item === "string"))
        ) {
            attrs[key] = value;
        }
    }
    return { attrs, body: typeof parsed.body === "string" ? parsed.body : "" };
}

function subagentRelativePath(definition: SubAgentDefinition, reviewerMode: ReviewerSubAgentMode) {
    const file = definition.id === SUBAGENTS.REVIEWER && reviewerMode === "verify" && definition.verifyFile
        ? definition.verifyFile
        : definition.file;
    return join(SUBAGENT_DEFINITIONS_DIR, file);
}

async function readBundledPromptFrontMatter(
    relativePath: string,
) {
    let lastError: Error = new Error("Bundled prompt read failed.");
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const promptPath = await ensureBundledAgentDefFile(relativePath);
            const raw = await fsReadFile(promptPath, "utf8");
            if (!raw.trim()) throw new TypeError("Prompt file was empty during bundled prompt load");
            const parsed = extractYaml<PromptFrontMatterAttrs>(raw);
            if (Object.hasOwn(parsed.attrs, "bashAllowedCommands")) {
                normalizeBashAllowedCommands(parsed.attrs.bashAllowedCommands as string[] | null, promptPath);
            }
            return normalizeBundledPromptFrontMatter(parsed);
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            lastError = error;
            if (!isRecoverableBundledPromptReadError(error)) throw error;
            if (attempt < 2) await delay(10 * (attempt + 1));
        }
    }
    if (!isRecoverableBundledPromptReadError(lastError)) throw lastError;
    const fallbackPath = join(AGENT_DEFS_DIR, relativePath);
    const parsed = extractYaml<PromptFrontMatterAttrs>(await fsReadFile(fallbackPath, "utf8"));
    if (Object.hasOwn(parsed.attrs, "bashAllowedCommands")) {
        normalizeBashAllowedCommands(parsed.attrs.bashAllowedCommands as string[] | null, fallbackPath);
    }
    return normalizeBundledPromptFrontMatter(parsed);
}

/**
 * Load a bare workflow prompt (no shared system prompt) into an AgentDefinition.
 *
 * The tool ceiling comes from the definition registry, not the prompt front
 * matter: a barePrompt subagent must declare `allowedTools` (its canonical
 * tool set) or explicitly opt out with `toolFree: true`. Missing both fails
 * closed — a silent `tools: []` would let the subagent's session start with
 * none of its required tools (the failure mode that once stripped the
 * Semantic Reviewer of `review_complete`), and the first sign of that would
 * be the workflow stalling mid-validation instead of a load error.
 *
 * Exported for tests that exercise the fail-closed guard with a crafted
 * definition.
 */
export async function loadBarePromptDefinition(
    definition: SubAgentDefinition,
    relativePath: string,
): Promise<AgentDefinition> {
    if (!definition.allowedTools && !definition.toolFree) {
        throw new Error(
            `Subagent definition "${definition.id}" (barePrompt) declares neither allowedTools nor toolFree: ` +
                "its session would silently run with no tools. Declare an explicit tool ceiling.",
        );
    }
    const { attrs, body } = await readBundledPromptFrontMatter(relativePath);
    if (attrs.tools !== undefined) {
        throw new Error(
            `Subagent prompt "${relativePath}" (barePrompt) declares a \`tools:\` field, which is ignored: ` +
                `the tool ceiling for "${definition.id}" comes from its allowedTools registry entry. ` +
                "Remove the field so the file cannot claim a ceiling it does not set.",
        );
    }
    const displayName = typeof attrs.name === "string" && attrs.name.trim()
        ? attrs.name.trim()
        : definition.displayNameFallback;
    const description = typeof attrs.description === "string" ? attrs.description.trim() : "";
    const sharedPracticePrompt = await composeSharedPracticePrompt(
        attrs.sharedPractice,
        definition.agentName,
    );

    return {
        name: definition.agentName,
        displayName,
        model: "",
        description,
        tools: [...(definition.allowedTools || [])],
        bashAllowedCommands: normalizeBashAllowedCommands(
            attrs.bashAllowedCommands as string[] | null | undefined,
            relativePath,
        ),
        systemPrompt: [body.trim(), sharedPracticePrompt].filter(Boolean).join("\n\n"),
    };
}

async function loadFullAgentDefinition(
    definition: SubAgentDefinition,
    relativePath: string,
): Promise<AgentDefinition> {
    const promptPath = await ensureBundledAgentDefFile(relativePath);
    return await loadAgentDefFromPath(promptPath, { agentName: definition.agentName });
}

/**
 * Appends a delegated role overlay to the base delegated prompt. The base prompt stays the
 * source of universal delegated-session rules; the overlay only adds the role-specific task.
 */
async function applyDelegatedRoleOverlay(
    agentDef: AgentDefinition,
    role: DelegatedRoleDefinition,
): Promise<AgentDefinition> {
    if (!role.overlayFile) return agentDef;
    const relativePath = join(SUBAGENT_DEFINITIONS_DIR, DELEGATED_ROLES_DIR, role.overlayFile);
    const { attrs, body } = await readBundledPromptFrontMatter(relativePath);
    const overlay = body.trim();
    if (!overlay) throw new Error(`Delegated role overlay is empty: ${relativePath}`);

    return {
        ...agentDef,
        displayName: typeof attrs.name === "string" && attrs.name.trim() ? attrs.name.trim() : agentDef.displayName,
        systemPrompt: `${agentDef.systemPrompt}\n\n${overlay}`,
    };
}

export async function loadSubAgentDefinition(
    id: SubAgentDefinitionId,
    options: LoadSubAgentDefinitionOptions = {},
): Promise<AgentDefinition> {
    const definition = SUBAGENT_DEFINITIONS[id];
    if (!definition) throw new Error(`Unknown subagent definition: ${id}`);
    const reviewerMode = options.reviewerMode || "discovery";
    const relativePath = subagentRelativePath(definition, reviewerMode);

    if (definition.loadMode !== "barePrompt") {
        return await loadFullAgentDefinition(definition, relativePath);
    }

    const agentDef = await loadBarePromptDefinition(definition, relativePath);
    if (id !== SUBAGENTS.DELEGATED && id !== SUBAGENTS.DELEGATED_READ) return agentDef;

    const role = getDelegatedRole(options.delegatedRole);
    if (!role) {
        throw new Error(
            `Unknown delegated role: ${options.delegatedRole}. Valid roles: ${DELEGATED_ROLE_IDS.join(", ")}.`,
        );
    }
    return await applyDelegatedRoleOverlay(agentDef, role);
}
