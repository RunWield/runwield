/**
 * @module extensions/mnemoteca
 * Mnemoteca memory extension for RunWield agent invocations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMnemotecaTools, type MnemotecaToolHost } from "./tools.ts";
export { memoryToolDef } from "./tools.ts";

/**
 * Register Mnemoteca lifecycle hooks and memory tools.
 */
export default function mnemotecaExtension(pi: ExtensionAPI): void {
    const host: MnemotecaToolHost = {
        cwd: Deno.cwd(),
        exec(command, args, options) {
            return pi.exec(command, args, options);
        },
    };

    pi.on("session_start", (_event, ctx) => {
        host.cwd = ctx.cwd;
    });

    for (const tool of createMnemotecaTools(host)) {
        pi.registerTool(tool);
    }
}
