/**
 * @module cmd/models
 * Handler for the model listing and switching command.
 */

import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { parseProviderModel } from "../../shared/models/model-validation.ts";
import { setDefaultModelSelection } from "../../shared/session/model-selection.ts";
import {
    applyUserModelSelection,
    listUserModelOptions,
    parseUserModelSelection,
} from "../../shared/session/user-selection.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { getCwd } from "../../constants.js";
import { COMMAND_NAMES } from "../registry.ts";
import { formatCommandHelp, printCommandHelp } from "../help/index.ts";
export { getModelCompletions } from "./getArgumentCompletions.ts";

interface ModelSelectItem {
    value: string;
    label: string;
}

interface ModelsCommandUi {
    appendSystemMessage(message: string, isError?: boolean): void;
    promptSelect(title: string, options: ModelSelectItem[]): Promise<string | null>;
}

interface ModelsCommandEditor {
    disableSubmit: boolean;
    setText(text: string): void;
}

interface ModelsCommandOptions {
    uiAPI?: ModelsCommandUi;
    editor?: ModelsCommandEditor;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
}

async function activateModel(
    options: ModelsCommandOptions,
    model: string,
    provider: string,
) {
    if (!options.sessionRuntime || !options.sessionId) return null;
    const result = await applyUserModelSelection(options.sessionRuntime, options.sessionId, model, provider);
    const snapshot = options.sessionRuntime.getSessionSnapshot(options.sessionId);
    if (result.ok && !snapshot?.activeAgent) await setDefaultModelSelection(snapshot?.cwd || getCwd(), model, provider);
    return result;
}

export async function runModelsCommand(
    argv: string[],
    options: ModelsCommandOptions = {},
): Promise<"succeeded" | "failed" | "canceled" | void> {
    const { uiAPI, editor } = options;
    const firstArg = argv[0]?.trim();

    if (firstArg === "help" || firstArg === "--help" || firstArg === "-h") {
        const help = formatCommandHelp(COMMAND_NAMES.MODEL);
        if (uiAPI && help) uiAPI.appendSystemMessage(help);
        else printCommandHelp(COMMAND_NAMES.MODEL);
        return;
    }

    const modelRegistry = getModelRegistry();
    await modelRegistry.getRuntime();

    if (!firstArg) {
        if (!uiAPI) {
            console.log("Usage: wld model <provider>/<model_id>");
            return;
        }

        const available = await listUserModelOptions();
        let outcome: "succeeded" | "failed" | "canceled" = "canceled";
        if (available.length === 0) {
            uiAPI.appendSystemMessage("No models available.");
            outcome = "failed";
        } else {
            const selection = await uiAPI.promptSelect(
                "Select model",
                available.map((model) => ({
                    value: `${model.provider}/${model.id}`,
                    label: model.name
                        ? `${model.name} (${model.provider}/${model.id})`
                        : `${model.provider}/${model.id}`,
                })),
            );
            if (selection) {
                try {
                    const parsed = parseUserModelSelection(selection);
                    const activation = await activateModel(options, parsed.model, parsed.provider);
                    if (!activation) {
                        await setDefaultModelSelection(getCwd(), parsed.model, parsed.provider);
                        uiAPI.appendSystemMessage(`Set default model to ${parsed.provider}/${parsed.model}`);
                        outcome = "succeeded";
                    } else if (!activation.ok) {
                        uiAPI.appendSystemMessage(
                            `Could not switch model to ${parsed.provider}/${parsed.model}: ${activation.error}. The active model did not change.`,
                            true,
                        );
                        outcome = "failed";
                    } else {
                        uiAPI.appendSystemMessage(`Switched model to ${activation.provider}/${activation.model}`);
                        outcome = "succeeded";
                    }
                } catch (error) {
                    uiAPI.appendSystemMessage(error instanceof Error ? error.message : String(error), true);
                    outcome = "failed";
                }
            }
        }
        editor?.setText("");
        if (editor) editor.disableSubmit = false;
        return outcome;
    }

    const parsedArgs = parseProviderModel(firstArg);
    if (!parsedArgs.ok) {
        if (uiAPI) uiAPI.appendSystemMessage("Invalid model format. Use /model to switch.", true);
        else console.log("Invalid model format. Use provider/id.");
        return "failed";
    }

    const targetModel = modelRegistry.find(parsedArgs.provider, parsedArgs.id);
    if (!targetModel) {
        const message = parsedArgs.provider === "agy-cli"
            ? `Unsupported Antigravity CLI model: ${firstArg}. Select agy-cli/gemini-3.8-flash or agy-cli/gemini-3.1-pro.`
            : `Unknown model: ${firstArg}. Use /model to switch.`;
        if (uiAPI) uiAPI.appendSystemMessage(message, true);
        else console.log(parsedArgs.provider === "agy-cli" ? message : `Unknown model: ${firstArg}`);
        return "failed";
    }

    const activation = await activateModel(options, targetModel.id, targetModel.provider);
    if (!activation) {
        await setDefaultModelSelection(getCwd(), targetModel.id, targetModel.provider);
        if (uiAPI) uiAPI.appendSystemMessage(`Set default model to ${targetModel.provider}/${targetModel.id}`);
        else console.log(`Set default model to ${targetModel.provider}/${targetModel.id}`);
        return;
    }
    const message = activation.ok
        ? `Switched model to ${activation.provider}/${activation.model}`
        : `Could not switch model to ${targetModel.provider}/${targetModel.id}: ${activation.error}. The active model did not change.`;
    if (uiAPI) uiAPI.appendSystemMessage(message, !activation.ok);
    else console.log(message);
    return activation.ok ? "succeeded" : "failed";
}
