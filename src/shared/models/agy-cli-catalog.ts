/** Fixed public families; availability depends on the user's CLI and account. */
export const AGY_CLI_MODEL_IDS = [
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-3.8-flash",
    "gemini-3.1-pro",
] as const;

export const AGY_CLI_DISPLAY_NAMES: Record<(typeof AGY_CLI_MODEL_IDS)[number], string> = {
    "gemini-4-argon": "Antigravity CLI Gemini 4 Argon",
    "gemini-4-hydrogen": "Antigravity CLI Gemini 4 Hydrogen",
    "gemini-4-carbon": "Antigravity CLI Gemini 4 Carbon",
    "gemini-3.8-flash": "Antigravity CLI Gemini 3.8 Flash",
    "gemini-3.1-pro": "Antigravity CLI Gemini 3.1 Pro",
};

export const AGY_CLI_MODEL_CHOICES = AGY_CLI_MODEL_IDS.map((id) => `agy-cli/${id}`).join(", ");
