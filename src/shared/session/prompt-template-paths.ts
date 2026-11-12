import { join } from "node:path";
import { PROMPT_TEMPLATES_DIR } from "../../constants.js";
import { personalGlobalRoot } from "../remote/personal-resources.ts";

export function homePromptsDir(): string {
    return join(personalGlobalRoot(), "prompts");
}

/** Resolve template search paths without loading the Session execution runtime. */
export function getPromptTemplatePaths(cwd?: string): string[] {
    return [...(cwd ? [join(cwd, ".wld", "prompts")] : []), homePromptsDir(), PROMPT_TEMPLATES_DIR];
}
