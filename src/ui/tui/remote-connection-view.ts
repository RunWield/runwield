import { Key, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";

/** Status facts supplied by the local remote-connection supervisor. No project is opened here. */
export interface RemoteConnectionViewConfig {
    host: string;
    cwd: string;
    status: string;
    trust: string;
    readiness: string;
}

function safeLine(value: string): string {
    // The supervisor receives these strings from a remote host. Never render
    // terminal control sequences or multiline output supplied by that host.
    // deno-lint-ignore no-control-regex -- Replace terminal controls and line separators in remote text.
    return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").trim();
}

/** Validate the first line of stdin before creating a terminal or TUI. */
export function parseRemoteConnectionViewConfig(line: string): RemoteConnectionViewConfig {
    const parsed: RemoteConnectionViewConfig = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid remote view configuration");
    }
    for (const field of ["host", "cwd", "status", "trust", "readiness"] as const) {
        if (typeof parsed[field] !== "string" || !safeLine(parsed[field])) {
            throw new Error(`Invalid remote view ${field}`);
        }
    }
    return parsed;
}

/** Display connection facts only. No chat, project, model or settings are initialized. */
export function showRemoteConnectionView(tui: TUI, config: RemoteConnectionViewConfig): Promise<void> {
    tui.addChild(
        new Text(
            [
                "Remote connection",
                "",
                `Host: ${safeLine(config.host)}`,
                `Directory: ${safeLine(config.cwd)}`,
                `Status: ${safeLine(config.status)}`,
                `Trust: ${safeLine(config.trust)}`,
                `Readiness: ${safeLine(config.readiness)}`,
                "",
                "Press q, Ctrl-C, or Ctrl-D to exit.",
            ].join("\n"),
            0,
            0,
        ),
    );
    // Paint the facts before queued exit input can stop the renderer.
    tui.renderNow();
    return new Promise((resolve) => {
        const remove = tui.addInputListener((data) => {
            if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
                remove();
                resolve();
            }
            // This screen never forwards input to chat, command or settings handlers.
            return { consume: true };
        });
    });
}
