import type { InteractiveSessionRuntime } from "@runwield/session-runtime/services";
import {
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
    type RuntimeInteractionRequest,
} from "@runwield/session-runtime/interactions";
import type { AcpCommandInvocation, AcpServerCommandHost } from "@runwield/acp";
import type { SelectOption } from "../../ui/tui/api.ts";
import { getCommandDefinition, getSlashCommandDefinition } from "../registry.ts";
import {
    applyUserModelSelection,
    listUserModelOptions,
    parseUserModelSelection,
} from "../../shared/session/user-selection.ts";
import { SlashCommandMetricsTracker, type SlashCommandOutcome } from "../../shared/workflow/command-metrics.ts";

interface AcpCommandUiOptions {
    runtime: InteractiveSessionRuntime;
    runtimeSessionId: string;
    sendMessage(text: string, isError?: boolean): void;
    onCanceled(): void;
}

type AcpTextOptions = Pick<RuntimeInteractionRequest, "defaultValue" | "placeholder" | "allowEmpty">;

function createAcpCommandUiAPI(options: AcpCommandUiOptions) {
    const requestSelection = async (
        type: RuntimeInteractionRequest["type"],
        title: string,
        choices: SelectOption[],
        requestOptions: AcpTextOptions = {},
    ) => {
        const response = await options.runtime.requestInteraction(options.runtimeSessionId, {
            type,
            prompt: title,
            options: choices,
            defaultValue: requestOptions.defaultValue,
            placeholder: requestOptions.placeholder,
            allowEmpty: requestOptions.allowEmpty,
        });
        if (
            response.outcome === RuntimeInteractionOutcomes.CANCELED ||
            response.outcome === RuntimeInteractionOutcomes.UNSUPPORTED ||
            response.outcome === RuntimeInteractionOutcomes.BLOCKED
        ) {
            if (response.outcome === RuntimeInteractionOutcomes.CANCELED) options.onCanceled();
            if (response.message) options.sendMessage(response.message, true);
            return null;
        }
        if (response.outcome === RuntimeInteractionOutcomes.SELECTED && response.value === "cancel")
            options.onCanceled();
        return String(response.value || "");
    };
    const appendAgentText = (text: string) => options.sendMessage(text);
    const promptSelect = (title: string, choices: SelectOption[]) =>
        requestSelection(RuntimeInteractionTypes.SELECT, title, choices);
    const promptText = (title: string, textOptions: AcpTextOptions = {}) =>
        requestSelection(RuntimeInteractionTypes.TEXT, title, [], {
            defaultValue: textOptions.defaultValue,
            placeholder: textOptions.placeholder,
            allowEmpty: textOptions.allowEmpty,
        });
    return {
        appendSystemMessage: options.sendMessage,
        appendAgentMessageStart: () => ({ appendText: appendAgentText }),
        requestRender: () => {},
        abortActivePrompt: () => {},
        promptSelect,
        promptText,
        showModelSelector: async (initialSearchInput = "") => {
            const available = await listUserModelOptions();
            const choices = available.map((model) => ({
                value: `${model.provider}/${model.id}`,
                label: model.name ? `${model.name} (${model.provider}/${model.id})` : `${model.provider}/${model.id}`,
            }));
            const selected = await requestSelection(RuntimeInteractionTypes.SELECT, "Select model", choices, {
                defaultValue: initialSearchInput,
            });
            if (!selected) return { selected: false };
            const parsed = parseUserModelSelection(selected);
            const result = await applyUserModelSelection(
                options.runtime,
                options.runtimeSessionId,
                parsed.model,
                parsed.provider,
            );
            if (!result.ok) {
                options.sendMessage(
                    `Could not switch model to ${parsed.provider}/${parsed.model}: ${result.error}. The active model did not change.`,
                    true,
                );
                return { selected: false };
            }
            return { selected: true };
        },
    };
}

async function executeAcpCommand(runtime: InteractiveSessionRuntime, options: AcpCommandInvocation): Promise<void> {
    let runtimeSessionId = options.runtimeSessionId;
    const definition = getSlashCommandDefinition(options.commandName, "acp");
    const sendMessage = options.sendMessage;
    let menuCanceled = false;
    if (!definition) {
        const root = runtime.getSessionSnapshot?.(runtimeSessionId)?.cwd;
        if (root) {
            const rejected = new SlashCommandMetricsTracker({
                command: "unknown",
                kind: "builtin",
                surface: "acp",
                projectRoot: root,
                sessionId: runtimeSessionId,
                requestId: options.requestId,
            });
            await rejected.recordStart();
            await rejected.recordFinish({ outcome: "rejected", errorReason: "unknown_command" });
        }
        const reserved = getCommandDefinition(options.commandName);
        sendMessage(
            reserved
                ? `Command /${options.commandName} is not available in ACP.`
                : `Unknown command: /${options.commandName}`,
        );
        return;
    }
    if (["help", "--help", "-h"].includes(options.args[0] || "")) {
        const root = runtime.getSessionSnapshot?.(runtimeSessionId)?.cwd;
        const helpTracker = root
            ? new SlashCommandMetricsTracker({
                  command: definition.name,
                  kind: "builtin",
                  surface: "acp",
                  projectRoot: root,
                  sessionId: runtimeSessionId,
                  requestId: options.requestId,
              })
            : null;
        await helpTracker?.recordStart();
        await helpTracker?.recordDispatched();
        const { formatCommandHelp } = await import("../help/index.ts");
        sendMessage(formatCommandHelp(definition.name) || `No help is available for /${definition.name}.`);
        await helpTracker?.recordFinish({ outcome: "succeeded" });
        return;
    }
    const commandUiAPI = createAcpCommandUiAPI({
        runtime,
        get runtimeSessionId() {
            return options.runtimeSessionId;
        },
        sendMessage,
        onCanceled: () => {
            menuCanceled = true;
        },
    });
    const commandEditor = {
        disableSubmit: false,
        setText: () => {},
        setAutocompleteProvider: () => {},
        handleInput: () => {},
    };
    const commandTui = { requestRender: () => {}, setFocus: () => {} };
    const snapshot = runtime.getSessionSnapshot?.(runtimeSessionId);
    const tracker = snapshot?.cwd
        ? new SlashCommandMetricsTracker({
              command: definition.name,
              alias: options.commandName !== definition.name ? options.commandName : undefined,
              kind: "builtin",
              surface: "acp",
              projectRoot: snapshot.cwd,
              sessionId: runtimeSessionId,
              requestId: options.requestId,
          })
        : null;
    const picker = (definition.name === "agent" || definition.name === "model") && options.args.length === 0;
    await tracker?.recordStart(picker ? "opened" : "start");
    if (!picker) await tracker?.recordDispatched();
    if (picker) {
        const select = commandUiAPI.promptSelect;
        commandUiAPI.promptSelect = async (...args) => {
            const selected = await select(...args);
            if (selected) await tracker?.recordDispatched();
            return selected;
        };
        const showModelSelector = commandUiAPI.showModelSelector;
        commandUiAPI.showModelSelector = async (...args) => {
            const result = await showModelSelector(...args);
            if (result.selected) await tracker?.recordDispatched();
            return result;
        };
    }
    let outcome: SlashCommandOutcome = "succeeded";
    let errorReason = null;
    try {
        const result = await definition.execute(options.args, {
            uiAPI: commandUiAPI,
            editor: commandEditor,
            tui: commandTui,
            sessionRuntime: runtime,
            sessionId: runtimeSessionId,
            slashSurface: "acp",
            commandInvocationId: tracker?.invocationId,
            replaceRuntimeSession: (nextSessionId) => {
                options.replaceRuntimeSession(nextSessionId);
                runtimeSessionId = nextSessionId;
            },
        });
        if (result === "failed" || result === "canceled" || result === "rejected") outcome = result;
    } catch (execError) {
        outcome = options.cancelled ? "canceled" : "failed";
        errorReason = "failed";
        throw execError;
    } finally {
        if ((options.cancelled || menuCanceled) && outcome !== "failed") outcome = "canceled";
        await tracker?.recordFinish({
            outcome: outcome,
            errorReason,
        });
    }
}

/** Route ACP slash commands through the existing CLI registry and metrics. */
export function createAcpCommandHost(runtime: InteractiveSessionRuntime): AcpServerCommandHost {
    const reviewTracker = (sessionId: string) => {
        const projectRoot = runtime.getSessionSnapshot(sessionId)?.cwd;
        return projectRoot
            ? new SlashCommandMetricsTracker({
                  command: "plan-review",
                  kind: "builtin",
                  surface: "acp",
                  projectRoot,
                  sessionId,
              })
            : null;
    };
    return {
        execute: (invocation) => executeAcpCommand(runtime, invocation),
        async reopenPlanReview(sessionId) {
            const tracker = reviewTracker(sessionId);
            await tracker?.recordStart();
            await tracker?.recordDispatched();
            try {
                const result = await runtime.reopenPlanReview(sessionId);
                await tracker?.recordFinish({ outcome: result.url ? "succeeded" : "failed" });
                return result;
            } catch (error) {
                await tracker?.recordFinish({ outcome: "failed", errorReason: "failed" });
                throw error;
            }
        },
        async recordBusyPlanReview(sessionId) {
            const tracker = reviewTracker(sessionId);
            await tracker?.recordStart();
            await tracker?.recordFinish({ outcome: "rejected", errorReason: "unavailable" });
        },
    };
}
