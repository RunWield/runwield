/**
 * @module shared/session/types
 */

/**
 * @typedef {{
 *   type?: string,
 *   text?: string,
 *   [key: string]: unknown,
 * }} SessionContentBlock
 */

/**
 * @typedef {{ base64: string, mimeType: string, ref?: string, path?: string }} ImageAttachment
 */

/** @typedef {import("../../tools/delegate-agent.ts").DelegationMode} DelegationMode */

/**
 * @typedef {Object} AgentDefinition
 * @property {string} name - Agent name (from frontmatter or filename)
 * @property {string} displayName - Agent display name (from frontmatter or filename)
 * @property {string} model - Model identifier
 * @property {string} description - One-line description from merged frontmatter
 * @property {"quick-fix"|"plan-execution"|"frontend-plan-execution"|"validation-repair"} [contextContract] - Declared execution context contract from merged frontmatter; metadata only, never runtime authority
 * @property {string[]} tools - Allowed tool names from merged frontmatter
 * @property {DelegationMode[]} [delegationModes] - Modes `delegate_agent` may use; absent allows every mode
 * @property {readonly string[]} [bashAllowedCommands] - Restricted RunWield shell selectors; absent means unrestricted
 * @property {boolean} [workflowOnly] - True when merged frontmatter marks the Agent as workflow-activated only, so it is hidden from `/agent` listings and manual selection
 * @property {readonly string[]} [busyLines] - One or more busy indicator lines from frontmatter; the UI picks one at random when the agent is active; absent falls back to "Working..."
 * @property {string} [thinkingLevel] - Thinking/reasoning level from frontmatter ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
 * @property {number} [temperature] - Provider temperature from frontmatter, between 0 and 2
 * @property {string} systemPrompt - Core system prompt + merged agent prompt
 */

/**
 * @typedef {Object} AgentRolePrompt
 * @property {string} rolePrompt - Merged agent prompt and shared practice, without the Core system prompt template
 */

/**
 * An agent definition loaded from its layered files.
 * @typedef {AgentDefinition & AgentRolePrompt} LoadedAgentDefinition
 */

/**
 * @typedef {{
 *   role: string,
 *   content: SessionContentBlock[],
 *   stopReason?: string,
 *   errorMessage?: string,
 * }} SessionMessageLike
 */

/**
 * @typedef {{
 *   role: "bashExecution",
 *   command: string,
 *   output: string,
 *   exitCode: number | undefined,
 *   cancelled: boolean,
 *   truncated: boolean,
 *   fullOutputPath?: string,
 *   timestamp: number,
 *   excludeFromContext?: boolean,
 * }} BashExecutionMessageLike
 */

/**
 * @typedef {import('@earendil-works/pi-coding-agent').SessionManager & {
 *   addMessage?: (message: SessionMessageLike | BashExecutionMessageLike) => void,
 *   appendMessage?: (message: SessionMessageLike | BashExecutionMessageLike) => string,
 *   appendCustomMessageEntry?: (role: string, text: string, visible: boolean, persisted?: string) => void,
 *   getHeader?: () => ({ timestamp?: string } | null),
 * }} SessionManagerLike
 */

/**
 * @typedef {Object} AgentTurnCompleteResult
 * @property {"complete"} kind
 */

/**
 * @typedef {AgentTurnCompleteResult} AgentTurnResult
 */

/**
 * @typedef {(userRequest: string, images: ImageAttachment[], sessionManager: SessionManagerLike) => Promise<AgentTurnResult>} AgentMessageHandler
 */

export {};
