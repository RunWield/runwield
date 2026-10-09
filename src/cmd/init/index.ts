/**
 * @module cmd/init
 * Init command handler — bootstraps RunWield into a project.
 *
 * Implements both CLI (`wld init`) and TUI slash (`/init`) dispatch.
 * Uses init-state guard to warn on re-runs. Loads the hidden init subagent
 * definition, so it stays invisible to /agent listings and uses its own
 * model/tools.
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl } from "@std/path";
import { AGENTS, getCwd, SUBAGENTS } from "../../constants.js";
import { COMMAND_NAMES } from "../registry.js";
import { EMPTY_PROJECT_DIRECTORY_INIT_NOOP_BODY, isEmptyProjectDirectory } from "../../shared/project-state.ts";
import { extractBundledAgentDefs, extractBundledSkills } from "../../shared/session/agent-assets.ts";
import { extractBundledModelPresets } from "../../shared/model-presets.ts";
import { createSessionRuntime, SessionRuntime } from "../../shared/session/session-runtime.ts";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { printCommandHelp } from "../help/index.ts";
import { recordInitDone, recordInitOffered } from "./init-state.ts";
import { isProjectInitComplete, requireProjectInitArtifact } from "./init-completion.ts";
import { createInitVerificationCommandOperation } from "../../tools/init-verification-command.ts";
import type { InteractiveSessionPort } from "../../ui/tui/interactive-session-port.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { confirmInitFiles, INIT_DECLINED_MESSAGE } from "./init-consent.ts";
import { recordInitializedProjectContext } from "../../shared/worktree-project-context.ts";

interface InitCommandBaseOptions {
    uiAPI?:
        & Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage">
        & Partial<Pick<import("../../ui/tui/types.js").UiAPI, "promptSelect">>;
    sessionPort: InteractiveSessionPort;
    projectRoot?: string;
}

interface AttachedInitCommandOptions extends InitCommandBaseOptions {
    sessionRuntime: SessionRuntime;
    sessionId: string;
}

interface StandaloneInitCommandOptions extends InitCommandBaseOptions {
    sessionRuntime?: never;
    sessionId?: never;
}

type InitCommandOptions = AttachedInitCommandOptions | StandaloneInitCommandOptions;

export const __dirname = dirname(fromFileUrl(import.meta.url));

/**
 * @param {{ getRegisteredProviderIds?: () => readonly string[], find?: (provider: string, modelId: string) => unknown }} registry
 * @param {{ getDefaultModel?: () => string | undefined, getDefaultProvider?: () => string | undefined }} settingsManager
 * @returns {boolean}
 */
function shouldLaunchTuiForModelSetup(
    registry: ReturnType<typeof getModelRegistry>,
    settingsManager: ReturnType<typeof getSettingsManager>,
): boolean {
    const configuredProviderIds = registry.getRegisteredProviderIds();
    if (configuredProviderIds.length === 0) return true;

    const defaultModel = settingsManager.getDefaultModel()?.trim();
    if (!defaultModel) return true;

    const defaultProvider = settingsManager.getDefaultProvider()?.trim() || "";
    return !registry.find(defaultProvider, defaultModel);
}

/**
 * Run the init command.
 */
export async function runInitCommand(argv: string[], options: InitCommandOptions): Promise<void> {
    const parsed = parseArgs(argv, {
        boolean: ["help"],
        alias: { h: "help" },
        stopEarly: true,
    });

    if (parsed.help) {
        printCommandHelp(COMMAND_NAMES.INIT);
        return;
    }

    const projectRoot = options.projectRoot || getCwd();

    if (await isEmptyProjectDirectory(projectRoot)) {
        if (options.uiAPI) {
            options.uiAPI.appendSystemMessage(EMPTY_PROJECT_DIRECTORY_INIT_NOOP_BODY);
        } else {
            console.warn(EMPTY_PROJECT_DIRECTORY_INIT_NOOP_BODY);
        }
        return;
    }

    // ── Init-state guard ──────────────────────────────────────────
    if (await isProjectInitComplete(projectRoot)) {
        const msg = `[RunWield] Init has already been run for this project (${projectRoot}).\n` +
            `[RunWield] To re-run, delete or edit the entry in ~/.wld/init-state.json manually.`;
        if (options.uiAPI) {
            options.uiAPI.appendSystemMessage(msg);
        } else {
            console.warn(msg);
        }
        return;
    }

    // ── Extract bundled prompt assets before model resolution ──────
    // Fresh binary installs need real on-disk copies so external read tools can
    // access bundled skills and document-format references, even if init later
    // stops because no model is configured.
    await extractBundledAgentDefs();
    await extractBundledSkills();
    extractBundledModelPresets();

    if (!options.uiAPI && shouldLaunchTuiForModelSetup(getModelRegistry(), getSettingsManager(projectRoot))) {
        await options.sessionPort.startInteractiveSession(`/${COMMAND_NAMES.INIT}`, {
            initialAgentName: AGENTS.ROUTER,
        });
        return;
    }

    if (!await confirmInitFiles(options)) {
        if (options.uiAPI) options.uiAPI.appendSystemMessage(INIT_DECLINED_MESSAGE);
        else console.warn(INIT_DECLINED_MESSAGE);
        return;
    }
    await enterProjectRuntime(projectRoot);

    // ── Load init subagent definition ──────
    // The registry maps this prompt to the canonical "init" runtime identifier
    // rather than the file's basename ("init-agent-prompt").
    const attached = options.sessionRuntime !== undefined;
    const sessionRuntime = attached ? options.sessionRuntime : createSessionRuntime();
    const createdSessionId = attached
        ? options.sessionId
        : (await sessionRuntime.createInteractiveSession({ cwd: projectRoot, mode: "new" })).sessionId;

    await recordInitOffered(projectRoot);
    const verificationCommandOperation = createInitVerificationCommandOperation({ projectRoot });

    // Run the canonical hidden init agent, distinct from user-selectable Agents.
    try {
        const result = await sessionRuntime.runIsolatedAgent(createdSessionId, {
            agentName: AGENTS.INIT,
            userRequest: "Initialize this project for RunWield. Follow the instructions in your system prompt.",
            subAgentDefinition: { id: SUBAGENTS.INIT },
            customTools: [verificationCommandOperation.tool],
        });
        if (!Array.isArray(result) && result?.ok === false) {
            throw new Error(`Init agent did not start: ${result.error || "Runtime refused the operation"}`);
        }
        const confirmedCommand = verificationCommandOperation.getConfirmedCommand();
        if (!confirmedCommand) {
            throw new Error(
                "Init agent finished without saving a confirmed verification command. " +
                    "Initialization was not marked complete; run /init to retry.",
            );
        }
        await requireProjectInitArtifact(projectRoot);

        await recordInitializedProjectContext(projectRoot);
        await recordInitDone(projectRoot);

        if (options.uiAPI) {
            options.uiAPI.appendSystemMessage(
                "✅ Init complete. docs/domain-language.md has been written.",
            );
        } else {
            console.log(`\n[RunWield] ✅ Init complete for ${projectRoot}.`);
        }
    } catch (err) {
        // Don't record success if the agent failed or was aborted
        const msg = `[RunWield] Init failed: ${err instanceof Error ? err.message : String(err)}`;
        if (options.uiAPI) {
            options.uiAPI.appendSystemMessage(msg, true);
            return;
        }
        console.error(msg);
        throw err;
    } finally {
        if (!attached) sessionRuntime.closeSession(createdSessionId);
    }
}
