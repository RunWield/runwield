/**
 * @module cmd/version
 * Print runwield version and architecture.
 */

import { arch, platform } from "node:process";
import { VERSION } from "../../shared/version.js";
import type { UiAPI } from "../../ui/tui/types.js";

export interface VersionCommandOptions {
    uiAPI?: UiAPI;
}

const TARGET_ARCH: string = `${arch}-${platform}`;

/**
 * Run the version command — prints "runwield <version> (<target-triple>)" to stdout,
 * or to the active UI when invoked as an interactive slash command.
 */
export function runVersionCommand(_argv: string[] = [], options: VersionCommandOptions = {}): Promise<void> {
    const message = `runwield ${VERSION} (${TARGET_ARCH})`;
    if (options.uiAPI) {
        options.uiAPI.appendSystemMessage(message);
    } else {
        console.log(message);
    }
    return Promise.resolve();
}
