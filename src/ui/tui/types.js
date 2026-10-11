/**
 * @module ui/tui/types
 */

/**
 * @typedef {{ appendText: (delta: string) => void }} AgentMessageAppender
 */

/**
 * @typedef {{
 *   setOutput: (text: string) => void,
 *   endExecution: (isError: boolean, durationMs: number | null) => void,
 *   appendDisplayImage?: (base64: string, mimeType: string) => void,
 *   bodyText?: string,
 *   startTime: number,
 *   setExpanded?: (expanded: boolean) => void,
 * }} ToolExecutionBlockApi
 */

/**
 * @typedef {{ task: number, assignee: string, description: string }} RunningTask
 */

/**
 * @typedef {{ value: string, label: string, description?: string, [key: string]: unknown }} SelectOption
 * @typedef {{ selected: boolean }} ModelSelectorResult
 */

/**
 * @typedef {{
 *   appendThinkingStart?: () => { appendDelta: (delta: string) => void; end: () => void },
 *   appendSystemMessage: (text: string, isError?: boolean, header?: string, style?: { headingColor?: string, bodyColor?: string }) => void,
 *   appendAgentMessageStart: (agentName: string) => AgentMessageAppender,
 *   appendUserMessage?: (text: string) => void,
 *   appendImage?: (base64: string, mimeType: string) => void,
 *   appendQueuedMessage?: (id: string, text: string) => void,
 *   removeQueuedMessage?: (id: string) => void,
 *   requestRender: () => void,
 *   advanceSpinner?: () => void,
 *   setBusy?: (busy: boolean) => void,
 *   setAgentBusyLines?: (lines: readonly string[] | undefined) => void,
 *   setRunningTasks?: (tasks: RunningTask[]) => void,
 *   clearMessages?: () => void,
 *   promptSelect: (title: string, options: SelectOption[], hooks?: { onSelectionChange?: (value: string) => void, layout?: import('@earendil-works/pi-tui').SelectListLayoutOptions, hint?: string, persistResult?: boolean }) => Promise<string | null>,
 *   promptText: (title: string, options?: { defaultValue?: string, placeholder?: string, allowEmpty?: boolean, persistResult?: boolean }) => Promise<string | null>,
 *   promptComposerText?: (title: string, options?: { defaultValue?: string, placeholder?: string, allowEmpty?: boolean }) => Promise<string | null>,
 *   showModelSelector: (initialSearchInput?: string) => Promise<ModelSelectorResult | void> | ModelSelectorResult | void,
 *   disableInput?: () => void,
 *   enableInput?: () => void,
 *   startToolExecution?: (id: string, toolName: string, title: string) => ToolExecutionBlockApi,
 *   appendReviewResult?: (agentName: string, markdown: string, approved: boolean) => void,
 *   updateValidationProgress?: (progress: import('../../shared/session/session-runtime-events.js').RuntimeValidationProgress) => void,
 *   updateValidationReport?: (role: "engineer" | "reviewer", report: { agentName: string, markdown: string, approved?: boolean }) => void,
 *   clearValidationPanel?: (preserveProgress?: boolean) => void,
 *   setManagedSyncStatus?: (status: import('../../shared/session/session-runtime-events.js').RuntimeManagedSyncStateEvent) => void,
 *   getActiveToolBlock?: (id: string) => ToolExecutionBlockApi | undefined,
 *   toggleToolOutputsExpanded?: () => void,
 *   showKeyboardHelp?: (help: import('../../shared/session/session-help.ts').SessionHelpPayload) => void,
 *   hideKeyboardHelp?: () => void,
 *   addToolInvoked?: (event: import('@earendil-works/pi-coding-agent').SessionEvent) => void,
 *   addToolResult?: (event: import('@earendil-works/pi-coding-agent').SessionEvent) => void,
 *   isOutputSuppressed?: () => boolean,
 *   suppressOutput?: () => void,
 *   abortActivePrompt: () => void,
 *   focusActivePrompt?: () => boolean,
 *   dispose?: () => void,
 * }} UiAPI
 */

/**
 * @typedef {{
 *   disableSubmit: boolean,
 *   setText: (text: string) => void,
 *   setAutocompleteProvider: (provider: import('@earendil-works/pi-tui').AutocompleteProvider) => void,
 *   handleInput: (data: string) => void | Promise<void>,
 *   onSubmit?: (text: string) => void | Promise<void>,
 *   onChange?: (text: string) => void,
 *   onFocus?: () => void,
 *   onBlur?: () => void,
 *   addToHistory?: (text: string) => void,
 * }} EditorAPI
 */

/**
 * @typedef {{
 *   requestRender: () => void,
 *   setFocus: (component: import('@earendil-works/pi-tui').Component | null) => void,
 *   addChild?: (component: import('@earendil-works/pi-tui').Component) => void,
 * }} TuiAPI
 */
