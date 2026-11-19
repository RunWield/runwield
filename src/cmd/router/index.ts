/** Router command, also used as the default command. */

import { COMMAND_NAMES } from "../registry.ts";
import { printCommandHelp } from "../help/index.ts";
import type { InteractiveSessionPort } from "../../ui/tui/interactive-session-port.ts";

interface RouterCommandOptions {
    sessionStartMode?: "new" | "continue";
    sessionPort: InteractiveSessionPort;
}

export async function runRouterCommand(
    argv: string[],
    options: RouterCommandOptions,
): Promise<void> {
    const userRequest = argv.join(" ").trim();

    if (userRequest === "help") {
        printCommandHelp(COMMAND_NAMES.ROUTER);
        return;
    }

    await options.sessionPort.startInteractiveSession(userRequest || null, {
        sessionStartMode: options.sessionStartMode || "new",
    });
}
