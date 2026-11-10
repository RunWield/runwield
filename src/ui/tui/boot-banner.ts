/** Boot summary printed at the top of an interactive session. */

import { getCwd, getHomeDir } from "../../constants.ts";
import { recordSnipMissingWarningShown, shouldShowSnipMissingWarning } from "../../cmd/init/init-state.ts";
import { hasSnipBinary } from "../../shared/runtime-preflight.ts";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { getSettingsManager } from "../../shared/settings.js";

interface PromptTemplate {
    name: string;
    source: "local" | "home" | "bundled" | "package";
    path?: string;
    packageSource?: string;
}

interface BootRuntimeToolsPort {
    hasSnipBinary(): Promise<boolean>;
}

interface RenderBootBannerOptions {
    uiAPI: import("./api.ts").UiAPI;
    invokablePromptTemplates: PromptTemplate[];
    blockedPromptTemplates: PromptTemplate[];
    chatPromptAgentName: string;
    sessionRuntime: SessionRuntime;
    sessionId: string;
    projectRoot?: string;
    runtimeTools?: BootRuntimeToolsPort;
}

interface AgentContextFile {
    path: string;
    source: "home" | "external" | "local";
}

const DEFAULT_RUNTIME_TOOLS: BootRuntimeToolsPort = { hasSnipBinary };

function toUserFacingPromptPath(template: PromptTemplate): string {
    if (template.source === "local") return `./.wld/prompts/${template.name}.md`;
    if (template.source === "home") return `~/.wld/prompts/${template.name}.md`;
    if (template.source === "package") {
        const origin = template.packageSource ? ` from ${template.packageSource}` : "";
        const path = template.path ? ` (${template.path})` : "";
        return `package prompt /${template.name}${origin}${path}`;
    }
    return `bundled prompt /${template.name}`;
}

function toUserFacingAgentMdPath(file: AgentContextFile, projectRoot: string): string {
    if (projectRoot && file.path.startsWith(projectRoot)) {
        return `.${file.path.slice(projectRoot.length)}`;
    }
    const homeDir = getHomeDir();
    if ((file.source === "home" || file.source === "external") && homeDir && file.path.startsWith(homeDir)) {
        return `~${file.path.slice(homeDir.length)}`;
    }
    return file.path;
}

export async function renderBootBanner({
    uiAPI,
    invokablePromptTemplates,
    blockedPromptTemplates,
    chatPromptAgentName,
    sessionRuntime,
    sessionId,
    projectRoot = getCwd(),
    runtimeTools = DEFAULT_RUNTIME_TOOLS,
}: RenderBootBannerOptions): Promise<void> {
    const headerStyle = { headingColor: "mdHeading" };
    const snipAvailable = await runtimeTools.hasSnipBinary();

    if (invokablePromptTemplates.length > 0) {
        const names = invokablePromptTemplates.map((template) => `/${template.name}`).join(", ");
        uiAPI.appendSystemMessage(
            `${names} (slash commands execute via ${chatPromptAgentName})`,
            false,
            `Prompt Templates (${invokablePromptTemplates.length}):`,
            headerStyle,
        );
    } else {
        uiAPI.appendSystemMessage("none", false, "Prompt Templates:", headerStyle);
    }

    const skills = await sessionRuntime.listSessionSkills(sessionId);
    if (skills.length > 0) {
        uiAPI.appendSystemMessage(
            skills.map((skill) => skill.name).join(", "),
            false,
            `Skills (${skills.length}):`,
            headerStyle,
        );
    } else {
        uiAPI.appendSystemMessage("none", false, "Skills:", headerStyle);
    }

    const activeTheme = getSettingsManager(projectRoot).getTheme() || "catppuccin-mocha";
    uiAPI.appendSystemMessage(activeTheme, false, "Theme:", headerStyle);

    if (snipAvailable) {
        uiAPI.appendSystemMessage("Snip", false, "Runtime Optimizers:", headerStyle);
    }

    const agentMdFiles = await sessionRuntime.listSessionContextFiles(sessionId);
    if (agentMdFiles.length > 0) {
        const lines = agentMdFiles
            .map((file) => `- ${toUserFacingAgentMdPath(file, projectRoot)}`)
            .join("\n");
        uiAPI.appendSystemMessage(`\n${lines}`, false, "Context:", headerStyle);
    }

    for (const blocked of blockedPromptTemplates) {
        if (blocked.source === "bundled") continue;
        uiAPI.appendSystemMessage(
            `Warning: ${
                toUserFacingPromptPath(blocked)
            } command can't be invoked because it would override RunWield built-in commands. Please rename it.`,
            true,
        );
    }

    if (!snipAvailable && await shouldShowSnipMissingWarning()) {
        uiAPI.appendSystemMessage(
            [
                "[RunWield] Snip is not installed. RunWield will still work, but agent shell command output will be noisier.",
                "Install Snip with `brew install edouard-claude/tap/snip` or see https://github.com/edouard-claude/snip#installation.",
            ].join("\n"),
            true,
        );
        await recordSnipMissingWarningShown();
    }
}
