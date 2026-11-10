import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
    Image,
    isFocusable,
    Spacer,
    type AutocompleteProvider,
    type Component,
    type Container,
    type Focusable,
    type SelectItem,
    type SelectListLayoutOptions,
} from "@earendil-works/pi-tui";
import { getSettingsManager } from "../../shared/settings.js";
import { WORKFLOW_TOOL_NAMES } from "../../tools/registry.ts";
import { imageTheme } from "../theme/theme.ts";
import type {
    RuntimeManagedSyncStateEvent,
    RuntimeValidationProgress,
} from "../../shared/session/session-runtime-events.js";
import type { DocumentLinkHost } from "../review/document-link-host.ts";
import type { SessionHelpPayload } from "../../shared/session/session-help.ts";
import {
    AgentMessageBlock,
    type EngineerReport,
    KeyboardHelpBlock,
    ManagedSyncStatusBlock,
    PromptSelectBlock,
    PromptTextBlock,
    ReviewResultBlock,
    type ReviewerReport,
    SystemMessageBlock,
    type SpinnerBlock,
    ThinkingBlock,
    ToolExecutionBlock,
    ToolExecutionGroupBlock,
    UserPromptBlock,
    ValidationHandoffBlock,
} from "./blocks.ts";

const MAX_MESSAGE_LIST_CHILDREN = 1000;
const WORKFLOW_TOOL_NAME_SET = new Set(WORKFLOW_TOOL_NAMES);

export interface AgentMessageAppender {
    appendText: (delta: string) => void;
}

export interface ToolExecutionBlockApi {
    setOutput: (text: string) => void;
    endExecution: (isError: boolean, durationMs: number | null) => void;
    appendDisplayImage?: (base64: string, mimeType: string) => void;
    bodyText?: string;
    startTime: number;
    setExpanded?: (expanded: boolean) => void;
}

export type ManagedSyncStatus = Omit<RuntimeManagedSyncStateEvent, "type" | "sessionId" | "timestamp">;

export interface RunningTask {
    task: number;
    assignee: string;
    description: string;
}

export type SelectOption = SelectItem;

export interface ModelSelectorResult {
    selected: boolean;
}

interface ThinkingAppender {
    appendDelta: (delta: string) => void;
    end: () => void;
}

interface SystemMessageStyle {
    headingColor?: string;
    bodyColor?: string;
}

interface SelectPromptHooks {
    onSelectionChange?: (value: string) => void;
    layout?: SelectListLayoutOptions;
    hint?: string;
    persistResult?: boolean;
}

interface ComposerPromptOptions {
    defaultValue?: string;
    placeholder?: string;
    allowEmpty?: boolean;
}

interface TextPromptOptions extends ComposerPromptOptions {
    persistResult?: boolean;
}

interface ValidationReport extends Pick<EngineerReport, "agentName" | "markdown"> {
    approved?: boolean;
}

export interface UiAPI {
    appendThinkingStart?: () => ThinkingAppender;
    appendSystemMessage: (text: string, isError?: boolean, header?: string, style?: SystemMessageStyle) => void;
    appendAgentMessageStart: (agentName: string) => AgentMessageAppender;
    appendUserMessage?: (text: string) => void;
    appendImage?: (base64: string, mimeType: string) => void;
    appendQueuedMessage?: (id: string, text: string) => void;
    removeQueuedMessage?: (id: string) => void;
    requestRender: () => void;
    advanceSpinner?: () => void;
    setBusy?: (busy: boolean) => void;
    setAgentBusyLines?: (lines: readonly string[] | undefined) => void;
    setRunningTasks?: (tasks: RunningTask[]) => void;
    clearMessages?: () => void;
    promptSelect: <Option extends SelectOption>(
        title: string,
        options: Option[],
        hooks?: SelectPromptHooks,
    ) => Promise<string | null>;
    promptText: (title: string, options?: TextPromptOptions) => Promise<string | null>;
    promptComposerText?: (title: string, options?: ComposerPromptOptions) => Promise<string | null>;
    showModelSelector: (
        initialSearchInput?: string,
    ) => Promise<ModelSelectorResult | void> | ModelSelectorResult | void;
    withHiddenInput?: <Result>(operation: () => Promise<Result>) => Promise<Result>;
    disableInput?: () => void;
    enableInput?: () => void;
    startToolExecution?: (id: string, toolName: string, title: string) => ToolExecutionBlockApi;
    appendReviewResult?: (agentName: string, markdown: string, approved: boolean) => void;
    updateValidationProgress?: (progress: RuntimeValidationProgress) => void;
    updateValidationReport?: (role: "engineer" | "reviewer", report: ValidationReport) => void;
    clearValidationPanel?: (preserveProgress?: boolean) => void;
    setValidationPanelVisible?: (visible: boolean) => void;
    setManagedSyncStatus?: (status: ManagedSyncStatus) => void;
    getActiveToolBlock?: (id: string) => ToolExecutionBlockApi | undefined;
    toggleToolOutputsExpanded?: () => void;
    showKeyboardHelp?: (help: SessionHelpPayload) => void;
    hideKeyboardHelp?: () => void;
    addToolInvoked?: (event: AgentSessionEvent) => void;
    addToolResult?: (event: AgentSessionEvent) => void;
    isOutputSuppressed?: () => boolean;
    suppressOutput?: () => void;
    abortActivePrompt: () => void;
    focusActivePrompt?: () => boolean;
    dispose?: () => void;
}

export interface EditorAPI {
    disableSubmit: boolean;
    setText: (text: string) => void;
    setAutocompleteProvider: (provider: AutocompleteProvider) => void;
    handleInput: (data: string) => void | Promise<void>;
    onSubmit?: (text: string) => void | Promise<void>;
    onChange?: (text: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    addToHistory?: (text: string) => void;
}

export interface TuiAPI {
    requestRender: () => void;
    setFocus: (component: Component | null) => void;
    addChild?: (component: Component) => void;
}

export interface ToolElapsedTimerState {
    renderTimer: ReturnType<typeof setTimeout> | null;
}

export type VisibleToolBlock = ToolExecutionGroupBlock | ToolExecutionBlock;

export type InteractiveUiAPI = UiAPI &
    Required<
        Pick<
            UiAPI,
            | "advanceSpinner"
            | "appendQueuedMessage"
            | "appendUserMessage"
            | "clearMessages"
            | "getActiveToolBlock"
            | "isOutputSuppressed"
            | "removeQueuedMessage"
            | "setBusy"
            | "setManagedSyncStatus"
            | "setRunningTasks"
            | "showKeyboardHelp"
            | "startToolExecution"
            | "suppressOutput"
            | "toggleToolOutputsExpanded"
            | "updateValidationProgress"
            | "updateValidationReport"
        >
    >;

type UiRenderTarget = Pick<TuiAPI, "requestRender" | "setFocus">;

// Pi keeps the current focus in a private field. Preserve the existing runtime read.
interface UiFocusView extends UiRenderTarget {
    focusedComponent?: Component | null;
}

interface UiBlockContainer extends Pick<Container, "children" | "addChild" | "removeChild"> {
    clear?: Container["clear"];
}

interface UiMessageList extends UiBlockContainer {
    clear: Container["clear"];
    invalidateChild?: (child: Component) => void;
}

interface BlockWithSpacer<Block> {
    block: Block;
    spacer: Spacer;
}

type InvalidatableMessageBlock =
    ToolExecutionBlock | ToolExecutionGroupBlock | ThinkingBlock | AgentMessageBlock | SystemMessageBlock;
type ValidationProgressListener = (progress: RuntimeValidationProgress | null) => void;

/**
 * Returns a fully-stubbed UiAPI whose methods all no-op. Use to suppress
 * output for parallel subagents that share the parent UI but should not
 * stream their own thinking/text blocks. Implements every method on the
 * UiAPI surface so adding a new method to api.ts doesn't silently fall
 * through to stdout in subagent contexts.
 */
export function createSilentUiApi(): UiAPI {
    return {
        appendThinkingStart: () => ({ appendDelta: () => {}, end: () => {} }),
        appendUserMessage: () => {},
        appendAgentMessageStart: () => ({ appendText: () => {} }),
        appendImage: () => {},
        appendQueuedMessage: () => {},
        removeQueuedMessage: () => {},
        appendReviewResult: () => {},
        updateValidationProgress: () => {},
        updateValidationReport: () => {},
        clearValidationPanel: () => {},
        setValidationPanelVisible: () => {},
        setManagedSyncStatus: () => {},
        appendSystemMessage: () => {},
        startToolExecution: () => ({
            setOutput: () => {},
            endExecution: () => {},
            bodyText: "",
            startTime: Date.now(),
        }),
        toggleToolOutputsExpanded: () => {},
        showKeyboardHelp: () => {},
        hideKeyboardHelp: () => {},
        getActiveToolBlock: () => undefined,
        requestRender: () => {},
        advanceSpinner: () => {},
        setBusy: () => {},
        setAgentBusyLines: () => {},
        setRunningTasks: () => {},
        clearMessages: () => {},
        promptSelect: () => Promise.resolve(null),
        promptText: () => Promise.resolve(null),
        showModelSelector: () => ({ selected: false }),
        disableInput: () => {},
        enableInput: () => {},
        isOutputSuppressed: () => true,
        suppressOutput: () => {},
        abortActivePrompt: () => {},
        focusActivePrompt: () => false,
    };
}

/**
 * Like createSilentUiApi(), but keeps footer-facing session state live by
 * allowing isolated Agent sessions to push agent/model info and by forwarding renders.
 */
export function createFooterOnlyUiApi(parentUiAPI: Pick<UiAPI, "requestRender"> | undefined): UiAPI {
    const uiAPI = createSilentUiApi();
    return {
        ...uiAPI,
        requestRender: () => parentUiAPI?.requestRender?.(),
        isOutputSuppressed: () => false,
    };
}

/**
 * Creates a UiAPI object for RunWield TUI.
 */
export function createUiApi(
    documentLinks: DocumentLinkHost | null,
    tui: UiRenderTarget,
    messageList: UiMessageList,
    spinner: SpinnerBlock,
    inputAccessoryContainer?: UiBlockContainer,
    validationPanelContainer?: UiBlockContainer,
    activeInteractionContainer?: UiBlockContainer,
    queuedInputContainer?: UiBlockContainer,
    getVisibleToolBlocks?: () => VisibleToolBlock[],
    onValidationProgress?: ValidationProgressListener,
): InteractiveUiAPI {
    const activeToolBlocks = new Map<string, ToolExecutionBlock>();

    const queuedMessageBlocks = new Map<string, BlockWithSpacer<SystemMessageBlock>>();

    const toolElapsedTimers = new Map<string, ToolElapsedTimerState>();

    let keyboardHelp: BlockWithSpacer<KeyboardHelpBlock> | null = null;

    let managedSyncStatus: BlockWithSpacer<ManagedSyncStatusBlock> | null = null;

    let visibleManagedSyncState: ManagedSyncStatus | null = null;

    const isSameVisibleManagedSyncState = (state: ManagedSyncStatus) => {
        return (
            visibleManagedSyncState?.status === state.status &&
            visibleManagedSyncState.localGeneration === state.localGeneration &&
            visibleManagedSyncState.latestGeneration === state.latestGeneration &&
            visibleManagedSyncState.owningSurfaceKind === state.owningSurfaceKind &&
            visibleManagedSyncState.message === state.message
        );
    };

    let activePromptCancel: (() => void) | null = null;

    let activePromptFocus: (() => void) | null = null;

    let currentToolGroup: ToolExecutionGroupBlock | null = null;
    let outputSuppressed = false;
    let runtimeBusy = false;
    let promptActive = false;
    let toolElapsedTimersPaused = false;

    let busyBlurredFocus: (Component & Focusable) | null = null;

    let validationProgress: RuntimeValidationProgress | null = null;

    let latestEngineerReport: EngineerReport | null = null;

    let latestReviewerReport: ReviewerReport | null = null;
    let validationReportOrder = 0;

    let validationPanelBlock: ValidationHandoffBlock | null = null;
    let validationPanelVisible = true;

    const removeInputAccessoryResources = () => {
        if (!inputAccessoryContainer) {
            keyboardHelp = null;
            managedSyncStatus = null;
            visibleManagedSyncState = null;
            return;
        }
        if (keyboardHelp) {
            inputAccessoryContainer.removeChild(keyboardHelp.block);
            inputAccessoryContainer.removeChild(keyboardHelp.spacer);
            keyboardHelp = null;
        }
        if (managedSyncStatus) {
            inputAccessoryContainer.removeChild(managedSyncStatus.block);
            inputAccessoryContainer.removeChild(managedSyncStatus.spacer);
            managedSyncStatus = null;
        }
        visibleManagedSyncState = null;
    };

    const renderValidationPanel = () => {
        if (!validationPanelContainer || outputSuppressed) return;
        if (!validationProgress || !validationPanelVisible) {
            validationPanelContainer.clear?.();
            validationPanelBlock = null;
            return;
        }
        const state = {
            progress: validationProgress,
            engineer: latestEngineerReport,
            reviewer: latestReviewerReport,
        };
        if (!validationPanelBlock) {
            validationPanelContainer.clear?.();
            validationPanelBlock = new ValidationHandoffBlock(state);
            validationPanelContainer.addChild(validationPanelBlock);
            validationPanelContainer.addChild(new Spacer(1));
        } else {
            validationPanelBlock.setState(state);
        }
    };

    const activePromptContainer = activeInteractionContainer || messageList;

    const isActiveMessageListChild = (child: Component) => {
        if (activeToolBlocks.size === 0) return false;
        const retainedActiveToolBlocks = new Set<Component>(activeToolBlocks.values());
        if (retainedActiveToolBlocks.has(child)) return true;
        return (
            child instanceof ToolExecutionGroupBlock &&
            child.children.some((block) => retainedActiveToolBlocks.has(block))
        );
    };

    const pruneMessageList = () => {
        if (messageList.children.length <= MAX_MESSAGE_LIST_CHILDREN) return;
        while (messageList.children.length > MAX_MESSAGE_LIST_CHILDREN) {
            const removable = messageList.children.find((child) => !isActiveMessageListChild(child));
            if (!removable) break;
            if (removable === currentToolGroup) currentToolGroup = null;
            messageList.removeChild(removable);
        }
        while (messageList.children[0] instanceof Spacer) {
            messageList.removeChild(messageList.children[0]);
        }
    };

    const closeCurrentToolGroup = () => {
        currentToolGroup = null;
    };

    const trimCompletedToolGroupChildren = () => {
        const activeBlocks = new Set(activeToolBlocks.values());
        for (const child of messageList.children) {
            if (child instanceof ToolExecutionGroupBlock) {
                child.trimCompletedChildren(activeBlocks, MAX_MESSAGE_LIST_CHILDREN);
            }
        }
    };

    const appendMessageListChild = (child: Component) => {
        messageList.addChild(child);
        pruneMessageList();
    };

    const invalidateMessageBlock = (block: InvalidatableMessageBlock) => {
        const messageChild = messageList.children.includes(block)
            ? block
            : block instanceof ToolExecutionBlock
              ? messageList.children.find((child) => child instanceof ToolExecutionGroupBlock && child.contains(block))
              : undefined;
        if (messageChild) messageList.invalidateChild?.(messageChild);
    };

    const suppressFocusedCursorForBusy = () => {
        const tuiFocus: UiFocusView = tui;
        const focused = tuiFocus.focusedComponent || null;
        if (!isFocusable(focused) || !focused.focused) return;
        busyBlurredFocus = focused;
        focused.focused = false;
    };

    const restoreFocusedCursorAfterBusy = () => {
        if (!busyBlurredFocus) return;
        const tuiFocus: UiFocusView = tui;
        if (tuiFocus.focusedComponent === busyBlurredFocus) {
            busyBlurredFocus.focused = true;
        }
        busyBlurredFocus = null;
    };

    let busyFrameTimer: ReturnType<typeof setInterval> | null = null;

    const stopBusyFrameTimer = () => {
        if (busyFrameTimer === null) return;
        clearInterval(busyFrameTimer);
        busyFrameTimer = null;
    };

    const renderBusyFrame = () => {
        if (!spinner.isBusy || outputSuppressed) return;
        spinner.advance();
        tui.requestRender();
    };

    const startBusyFrameTimer = () => {
        if (busyFrameTimer !== null || outputSuppressed) return;
        renderBusyFrame();
        busyFrameTimer = setInterval(renderBusyFrame, 120);
    };

    const beginPromptWait = () => {
        promptActive = true;
        spinner.setBusy(false, spinner.tasks);
        stopBusyFrameTimer();
        setToolElapsedTimersPaused(true);
        restoreFocusedCursorAfterBusy();
    };

    const endPromptWait = () => {
        promptActive = false;
        spinner.setBusy(runtimeBusy, spinner.tasks);
        setToolElapsedTimersPaused(!runtimeBusy);
        if (runtimeBusy) {
            suppressFocusedCursorForBusy();
            startBusyFrameTimer();
        }
    };

    const clearToolElapsedTimer = (id: string) => {
        const timer = toolElapsedTimers.get(id);
        if (!timer) return;
        if (timer.renderTimer) clearTimeout(timer.renderTimer);
        toolElapsedTimers.delete(id);
    };

    const startToolElapsedTimer = (id: string, block: ToolExecutionBlock) => {
        clearToolElapsedTimer(id);
        if (toolElapsedTimersPaused || outputSuppressed || block.ended) return;
        const timer: ToolElapsedTimerState = {
            renderTimer: null,
        };
        const renderElapsedFrame = () => {
            if (outputSuppressed || block.ended || activeToolBlocks.get(id) !== block) {
                clearToolElapsedTimer(id);
                return;
            }
            block.enableElapsedTime();
            invalidateMessageBlock(block);
            tui.requestRender();
            timer.renderTimer = setTimeout(renderElapsedFrame, 100);
            if (typeof timer.renderTimer.unref === "function") {
                timer.renderTimer.unref();
            }
        };
        toolElapsedTimers.set(id, timer);
        renderElapsedFrame();
    };

    /**
     * Code review can leave a tool pending for hours. Stop its repaint loop
     * along with the spinner; keep the block and start time for continuation.
     */
    const setToolElapsedTimersPaused = (paused: boolean) => {
        if (toolElapsedTimersPaused === paused) return;
        toolElapsedTimersPaused = paused;
        if (paused) {
            for (const id of toolElapsedTimers.keys()) clearToolElapsedTimer(id);
        } else {
            for (const [id, block] of activeToolBlocks) startToolElapsedTimer(id, block);
        }
    };

    return {
        /**
         * Start streaming a thinking block into the message list.
         */
        appendThinkingStart: () => {
            if (outputSuppressed) {
                return { appendDelta: () => {}, end: () => {} };
            }
            closeCurrentToolGroup();
            const hidden = getSettingsManager().getHideThinkingBlock?.() ?? false;
            const block = new ThinkingBlock({ hidden });
            appendMessageListChild(block);
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
            return {
                appendDelta: (delta) => {
                    block.appendText(delta);
                    invalidateMessageBlock(block);
                    tui.requestRender();
                },
                end: () => {
                    block.end();
                    invalidateMessageBlock(block);
                    tui.requestRender();
                },
            };
        },

        appendUserMessage: (text) => {
            if (outputSuppressed) return;
            closeCurrentToolGroup();
            const block = new UserPromptBlock(text);
            appendMessageListChild(block);
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
        },

        appendImage: (base64, mimeType) => {
            if (outputSuppressed) return;
            closeCurrentToolGroup();
            appendMessageListChild(
                new Image(base64, mimeType, imageTheme, {
                    maxWidthCells: 60,
                    maxHeightCells: 20,
                }),
            );
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
        },

        appendQueuedMessage: (id, text) => {
            if (outputSuppressed || queuedMessageBlocks.has(id)) return;
            closeCurrentToolGroup();
            const block = new SystemMessageBlock(text, false, "Steering:");
            const spacer = new Spacer(1);
            queuedMessageBlocks.set(id, { block, spacer });
            const queueContainer = queuedInputContainer || messageList;
            queueContainer.addChild(block);
            queueContainer.addChild(spacer);
            tui.requestRender();
        },

        removeQueuedMessage: (id) => {
            const queued = queuedMessageBlocks.get(id);
            if (!queued) return;
            const queueContainer = queuedInputContainer || messageList;
            queueContainer.removeChild(queued.block);
            queueContainer.removeChild(queued.spacer);
            queuedMessageBlocks.delete(id);
            tui.requestRender();
        },

        appendAgentMessageStart: (agentName) => {
            if (outputSuppressed) {
                return {
                    appendText: () => {},
                };
            }
            closeCurrentToolGroup();
            const block = new AgentMessageBlock(agentName, documentLinks);
            appendMessageListChild(block);
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
            return {
                appendText: (delta) => {
                    block.appendText(delta);
                    invalidateMessageBlock(block);
                    tui.requestRender();
                },
            };
        },

        appendReviewResult: (agentName, markdown, approved) => {
            if (outputSuppressed) return;
            closeCurrentToolGroup();
            const block = new ReviewResultBlock(agentName, markdown, approved);
            appendMessageListChild(block);
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
        },

        updateValidationProgress: (progress) => {
            if (outputSuppressed) return;
            validationProgress = structuredClone(progress);
            onValidationProgress?.(validationProgress);
            renderValidationPanel();
            tui.requestRender();
        },

        updateValidationReport: (role, report) => {
            if (outputSuppressed) return;
            const completedOrder = ++validationReportOrder;
            if (role === "engineer") {
                latestEngineerReport = { agentName: report.agentName, markdown: report.markdown, completedOrder };
            } else {
                latestReviewerReport = {
                    agentName: report.agentName,
                    markdown: report.markdown,
                    approved: report.approved === true,
                    completedOrder,
                };
            }
            if (validationProgress) {
                renderValidationPanel();
                tui.requestRender();
            }
        },

        setValidationPanelVisible: (visible) => {
            validationPanelVisible = visible;
            renderValidationPanel();
            tui.requestRender();
        },

        clearValidationPanel: (preserveProgress = false) => {
            validationProgress = null;
            if (!preserveProgress) onValidationProgress?.(null);
            latestEngineerReport = null;
            latestReviewerReport = null;
            validationReportOrder = 0;
            validationPanelContainer?.clear?.();
            validationPanelBlock = null;
            tui.requestRender();
        },

        appendSystemMessage: (text, isError = false, header = "", style = {}) => {
            if (outputSuppressed) return;
            closeCurrentToolGroup();
            const children = messageList.children;
            let lastBlockIndex = children.length - 1;
            while (lastBlockIndex >= 0 && children[lastBlockIndex] instanceof Spacer) {
                lastBlockIndex--;
            }

            const lastBlock = lastBlockIndex >= 0 ? children[lastBlockIndex] : null;

            if (
                lastBlock instanceof SystemMessageBlock &&
                lastBlock.isError === isError &&
                JSON.stringify(lastBlock.style) === JSON.stringify(style)
            ) {
                // Async status transitions can leave more than one trailing spacer.
                // Collapse them before extending the same visible message block so
                // publication and its immediate repair read as one continuous update.
                for (let index = children.length - 1; index > lastBlockIndex; index--) {
                    messageList.removeChild(children[index]);
                }
                lastBlock.appendText(text, header, style);
                invalidateMessageBlock(lastBlock);
                appendMessageListChild(new Spacer(1));
                tui.requestRender();
                return;
            }

            const block = new SystemMessageBlock(text, isError, header, style);
            appendMessageListChild(block);
            appendMessageListChild(new Spacer(1));
            tui.requestRender();
        },

        startToolExecution: (id, toolName, title) => {
            if (outputSuppressed) {
                return {
                    setOutput: () => {},
                    endExecution: () => {},
                    bodyText: "",
                    startTime: Date.now(),
                };
            }
            const block = new ToolExecutionBlock(toolName, title);
            const originalSetOutput = block.setOutput.bind(block);
            block.setOutput = (text) => {
                originalSetOutput(text);
                invalidateMessageBlock(block);
            };
            const originalAppendOutput = block.appendOutput.bind(block);
            block.appendOutput = (text) => {
                originalAppendOutput(text);
                invalidateMessageBlock(block);
            };
            const originalEndExecution = block.endExecution.bind(block);
            block.endExecution = (isError, durationMs) => {
                clearToolElapsedTimer(id);
                originalEndExecution(isError, durationMs);
                if (activeToolBlocks.get(id) === block) activeToolBlocks.delete(id);
                trimCompletedToolGroupChildren();
                invalidateMessageBlock(block);
                if (!outputSuppressed) tui.requestRender();
            };
            activeToolBlocks.set(id, block);
            const children = messageList.children;
            if (children.at(-1) instanceof Spacer && children.at(-2) instanceof ThinkingBlock) {
                messageList.removeChild(children.at(-1)!);
            }
            const isLocalShellCommand = title.startsWith("! ") || title.startsWith("!! ");
            if (isLocalShellCommand) {
                closeCurrentToolGroup();
                block.setExpanded(true);
                appendMessageListChild(block);
                appendMessageListChild(new Spacer(1));
            } else if (WORKFLOW_TOOL_NAME_SET.has(toolName) || toolName === "code_review") {
                closeCurrentToolGroup();
                appendMessageListChild(block);
                appendMessageListChild(new Spacer(1));
            } else {
                if (!currentToolGroup || !messageList.children.includes(currentToolGroup)) {
                    currentToolGroup = new ToolExecutionGroupBlock();
                    appendMessageListChild(currentToolGroup);
                    appendMessageListChild(new Spacer(1));
                }
                currentToolGroup.addBlock(block);
                trimCompletedToolGroupChildren();
            }
            startToolElapsedTimer(id, block);
            tui.requestRender();
            return block;
        },

        toggleToolOutputsExpanded: () => {
            const toolBlocks = messageList.children.filter(
                (child) => child instanceof ToolExecutionGroupBlock || child instanceof ToolExecutionBlock,
            );
            const retainedToolBlocks = new Set(toolBlocks);
            const requestedBlocks = getVisibleToolBlocks?.() ?? toolBlocks.slice(-1);
            const visibleToolBlocks = requestedBlocks.filter((block) => retainedToolBlocks.has(block));
            if (visibleToolBlocks.length === 0) return;

            const expand = !visibleToolBlocks.some((block) => block.expanded);
            for (const block of visibleToolBlocks) {
                block.setExpanded(expand);
                invalidateMessageBlock(block);
            }
            tui.requestRender();
        },

        showKeyboardHelp: (help) => {
            if (!inputAccessoryContainer || outputSuppressed) return;
            if (keyboardHelp) {
                inputAccessoryContainer.removeChild(keyboardHelp.block);
                inputAccessoryContainer.removeChild(keyboardHelp.spacer);
                keyboardHelp = null;
                tui.requestRender();
                return;
            }
            const block = new KeyboardHelpBlock(help);
            const spacer = new Spacer(1);
            keyboardHelp = { block, spacer };
            inputAccessoryContainer.addChild(block);
            inputAccessoryContainer.addChild(spacer);
            tui.requestRender();
        },

        hideKeyboardHelp: () => {
            if (!inputAccessoryContainer || !keyboardHelp) return;
            inputAccessoryContainer.removeChild(keyboardHelp.block);
            inputAccessoryContainer.removeChild(keyboardHelp.spacer);
            keyboardHelp = null;
            tui.requestRender();
        },

        setManagedSyncStatus: (state) => {
            if (!inputAccessoryContainer || outputSuppressed) return;
            if (state.status === "syncing" && !managedSyncStatus) return;
            if (state.status === "current" && !state.owningSurfaceKind) {
                if (managedSyncStatus) {
                    inputAccessoryContainer.removeChild(managedSyncStatus.block);
                    inputAccessoryContainer.removeChild(managedSyncStatus.spacer);
                    managedSyncStatus = null;
                    visibleManagedSyncState = null;
                    tui.requestRender();
                }
                return;
            }
            if (isSameVisibleManagedSyncState(state)) return;
            if (!managedSyncStatus) {
                const block = new ManagedSyncStatusBlock(state);
                const spacer = new Spacer(1);
                managedSyncStatus = { block, spacer };
                inputAccessoryContainer.addChild(block);
                inputAccessoryContainer.addChild(spacer);
            } else {
                managedSyncStatus.block.setState(state);
            }
            visibleManagedSyncState = { ...state };
            tui.requestRender();
        },

        getActiveToolBlock: (id) => {
            return activeToolBlocks.get(id);
        },

        requestRender: () => {
            if (outputSuppressed) return;
            tui.requestRender();
        },

        advanceSpinner: () => {
            if (outputSuppressed) return;
            spinner.advance();
            tui.requestRender();
        },

        setBusy: (busy) => {
            if (outputSuppressed && busy) return;

            runtimeBusy = busy;
            const displayBusy = busy && !promptActive;
            spinner.setBusy(displayBusy, spinner.tasks);
            setToolElapsedTimersPaused(!displayBusy);
            if (displayBusy) {
                suppressFocusedCursorForBusy();
                startBusyFrameTimer();
            } else {
                stopBusyFrameTimer();
                restoreFocusedCursorAfterBusy();
            }
            tui.requestRender();
        },

        setAgentBusyLines: (lines) => {
            spinner.setBusyLines(lines);
            if (!outputSuppressed) tui.requestRender();
        },

        setRunningTasks: (tasks) => {
            spinner.tasks = tasks;
            if (!outputSuppressed) tui.requestRender();
        },

        /** Forcefully cancel the active prompt, resolving its promise with null. */
        abortActivePrompt: () => {
            if (activePromptCancel) {
                activePromptCancel();
                activePromptCancel = null;
            }
        },

        focusActivePrompt: () => {
            if (!activePromptFocus) return false;
            activePromptFocus();
            tui.requestRender();
            return true;
        },

        promptSelect: (title, options, hooks) => {
            return new Promise((resolve) => {
                beginPromptWait();
                const block = new PromptSelectBlock(title, options, hooks?.hint, hooks?.layout);
                const spacer = new Spacer(1);
                activePromptContainer.addChild(block);
                activePromptContainer.addChild(spacer);

                activePromptFocus = () => tui.setFocus(block);
                tui.setFocus(block);
                tui.requestRender();

                const shouldPersistResult = hooks?.persistResult !== false && title !== "Switch agent:";

                // Single path for settling and cleanup
                const settleAndCleanup = (value: string | null) => {
                    activePromptCancel = null;
                    activePromptFocus = null;
                    activePromptContainer.removeChild(block);
                    activePromptContainer.removeChild(spacer);
                    if (shouldPersistResult && !outputSuppressed) {
                        closeCurrentToolGroup();
                        block.settle(value);
                        appendMessageListChild(block);
                        appendMessageListChild(spacer);
                    }
                    endPromptWait();
                    resolve(value);
                    tui.requestRender();
                };

                // Expose the cancel function so abortActivePrompt can resolve this promise
                activePromptCancel = () => settleAndCleanup(null);

                block.list.onSelect = (item) => settleAndCleanup(item.value);
                block.list.onCancel = () => settleAndCleanup(null);
                if (hooks?.onSelectionChange) {
                    block.list.onSelectionChange = (item) => {
                        hooks.onSelectionChange?.(item.value);
                        tui.requestRender();
                    };
                }
            });
        },

        promptText: (title, opts = {}) => {
            const { defaultValue, placeholder, allowEmpty = true, persistResult = true } = opts;

            return new Promise((resolve) => {
                beginPromptWait();
                const hints = ["enter submit", "esc cancel"];
                if (!allowEmpty) hints.unshift("non-empty required");
                const hintText = placeholder ? `${placeholder} • ${hints.join(" • ")}` : hints.join(" • ");

                const block = new PromptTextBlock(title, hintText);
                if (defaultValue) {
                    block.input.setValue(defaultValue);
                }

                const spacer = new Spacer(1);
                activePromptContainer.addChild(block);
                activePromptContainer.addChild(spacer);

                activePromptFocus = () => tui.setFocus(block);
                tui.setFocus(block);
                tui.requestRender();

                // Single path for settling and cleanup
                const settleAndCleanup = (value: string | null) => {
                    activePromptCancel = null;
                    activePromptFocus = null;
                    activePromptContainer.removeChild(block);
                    activePromptContainer.removeChild(spacer);
                    if (persistResult && !outputSuppressed) {
                        closeCurrentToolGroup();
                        block.settle(value);
                        appendMessageListChild(block);
                        appendMessageListChild(spacer);
                    }
                    endPromptWait();
                    resolve(value);
                    tui.requestRender();
                };

                // Expose the cancel function so abortActivePrompt can resolve this promise
                activePromptCancel = () => settleAndCleanup(null);

                block.input.onSubmit = (value) => {
                    const finalValue = value || defaultValue || "";
                    if (!allowEmpty && !finalValue.trim()) return;
                    settleAndCleanup(finalValue);
                };

                block.input.onEscape = () => settleAndCleanup(null);
            });
        },

        isOutputSuppressed: () => outputSuppressed,

        suppressOutput: () => {
            outputSuppressed = true;
            runtimeBusy = false;
            promptActive = false;
            spinner.setBusy(false, spinner.tasks);
            stopBusyFrameTimer();
            restoreFocusedCursorAfterBusy();
            if (activePromptCancel) {
                activePromptCancel();
            }
            tui.setFocus(null);
            validationPanelContainer?.clear?.();
            activeInteractionContainer?.clear?.();
            validationProgress = null;
            onValidationProgress?.(null);
            latestEngineerReport = null;
            latestReviewerReport = null;
            validationPanelBlock = null;
            validationReportOrder = 0;
            activePromptCancel = null;
            activePromptFocus = null;
            currentToolGroup = null;
            for (const id of toolElapsedTimers.keys()) {
                clearToolElapsedTimer(id);
            }
            removeInputAccessoryResources();
        },

        clearMessages: () => {
            if (activePromptCancel) {
                activePromptCancel();
                activePromptCancel = null;
            }
            activePromptFocus = null;
            tui.setFocus(null);
            messageList.clear();
            queuedInputContainer?.clear?.();
            validationPanelContainer?.clear?.();
            activeInteractionContainer?.clear?.();
            validationProgress = null;
            onValidationProgress?.(null);
            latestEngineerReport = null;
            latestReviewerReport = null;
            validationPanelBlock = null;
            validationReportOrder = 0;
            queuedMessageBlocks.clear();
            activeToolBlocks.clear();
            currentToolGroup = null;
            for (const id of Array.from(toolElapsedTimers.keys())) clearToolElapsedTimer(id);
            removeInputAccessoryResources();
            tui.requestRender();
        },

        dispose: () => {
            if (activePromptCancel) {
                activePromptCancel();
                activePromptCancel = null;
            }
            activePromptFocus = null;
            stopBusyFrameTimer();
            runtimeBusy = false;
            promptActive = false;
            restoreFocusedCursorAfterBusy();
            for (const id of Array.from(toolElapsedTimers.keys())) clearToolElapsedTimer(id);
            activeToolBlocks.clear();
            currentToolGroup = null;
            queuedMessageBlocks.clear();
            queuedInputContainer?.clear?.();
            removeInputAccessoryResources();
            validationProgress = null;
            onValidationProgress?.(null);
            latestEngineerReport = null;
            latestReviewerReport = null;
            validationPanelBlock = null;
            validationReportOrder = 0;
            validationPanelContainer?.clear?.();
            activeInteractionContainer?.clear?.();
            spinner.setBusy(false, spinner.tasks);
            tui.setFocus(null);
            tui.requestRender();
        },

        // Stubs that chat-session sets dynamically
        disableInput: () => {},
        enableInput: () => {},
        showModelSelector: () => ({ selected: false }),
    };
}
