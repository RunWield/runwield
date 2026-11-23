import type {
    DelegatedAuthority,
    DelegatedRoleId,
    LoadSubAgentDefinitionOptions,
    ResolvedDelegation,
    SubAgentDefinitionId,
} from "./isolated.ts";
import { AGENTS, SUBAGENTS } from "./role-ids.ts";
import { createRoleRegistry, type AgentDefinition, type AgentVisibility, type LoadedAgentDefinition } from "./roles.ts";

export interface AgentRegistryIds {
    readonly primary: typeof AGENTS;
    readonly isolated: typeof SUBAGENTS;
}

export interface IsolatedAgentRegistry {
    /** Load the selected definition. Resolve delegated requests through `delegation.resolve` first. */
    load(id: SubAgentDefinitionId, options?: LoadSubAgentDefinitionOptions): Promise<AgentDefinition>;
    /** Read the declared tool ceiling of a bare-prompt definition. Full definitions provide tools when loaded. */
    toolCeiling(id: SubAgentDefinitionId): readonly string[];
    displayNameFallback(id: SubAgentDefinitionId): string;
}

export interface AgentDelegationRegistry {
    /** Apply the role ceiling and select the definition for the resulting authority. */
    resolve(requestedAuthority: DelegatedAuthority, name?: string | null): ResolvedDelegation | null;
    listRoles(): readonly DelegatedRoleId[];
}

export interface AgentRegistry {
    readonly ids: AgentRegistryIds;
    readonly isolated: IsolatedAgentRegistry;
    readonly delegation: AgentDelegationRegistry;
    /** Return a readable path to bundled definitions, materializing a local copy when possible. */
    getBundledDefinitionsPath(): Promise<string>;
    /** Load the effective role from its current definition files. */
    get(name: string, projectRoot?: string): Promise<LoadedAgentDefinition>;
    /** List merged definitions. The default visibility is `selectable`. */
    list(projectRoot?: string, visibility?: AgentVisibility): Promise<LoadedAgentDefinition[]>;
    /** Scan top-level definition filenames, including workflow-only roles. */
    listNames(projectRoot?: string): Promise<string[]>;
    /** Canonicalize a filename-derived name or throw if it is invalid. */
    normalizeName(name: string): string;
    /** Read the display name from cached metadata or the definition files. */
    displayName(name: string, projectRoot?: string): string;
    /** Read busy labels from cached metadata or the definition files. */
    busyLines(name: string, projectRoot?: string): readonly string[] | undefined;
    isWorkflowOnly(name: string, projectRoot?: string): Promise<boolean>;
    /** Apply tool narrowing while retaining universal tools and adding custom tools. */
    selectTools(
        agentTools: readonly string[],
        toolNames?: readonly string[],
        customToolNames?: readonly string[],
    ): string[];
}

export function createAgentRegistry(): AgentRegistry {
    return {
        ...createRoleRegistry(),
        ids: { primary: AGENTS, isolated: SUBAGENTS },
    };
}
