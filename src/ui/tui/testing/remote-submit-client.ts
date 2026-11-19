import { stdinStream } from "../../../testing/stdin-stream.ts";
import { processLines } from "../../../shared/remote/remote-runtime-lines.ts";
import { configureRemotePersonalResources } from "../../../shared/remote/personal-resources.ts";
import { configureRemoteSettingsConnection } from "../../../shared/remote/settings-bridge.ts";
import { configureRemoteModelConnection } from "../../../shared/models/model-registry.ts";
import { configureRemoteClipboardConnection } from "../clipboard.ts";
import {
    RemoteSessionControl,
    type RemoteSessionControlConnection,
} from "../../../shared/remote/session-control-client.ts";
import { recordInitOffered } from "../../../cmd/init/init-state.ts";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import { type InteractiveLifecycleHandle, startInteractiveSession } from "../chat-session.ts";
import { initTUIWithPair, RunWieldTui, stopTUI } from "../tui.ts";
import { VirtualTerminal } from "./virtual-terminal.js";

export interface RemoteSubmitInput {
    connection: RemoteSessionControlConnection;
    resources: string;
    cwd: string;
}
export interface RemoteSubmitCommand {
    text?: string;
    expect?: string;
    key?: string;
    close?: boolean;
    waitForIdle?: boolean;
}
export interface RemoteSubmitReport {
    screen: string;
    processing: boolean;
    sessionId: string;
}
const lines = processLines(stdinStream());
const input: RemoteSubmitInput = JSON.parse((await lines.read()).value || "{}");
configureRemotePersonalResources({ globalRoot: input.resources });
configureRemoteSettingsConnection(input.connection);
const clearClipboard = configureRemoteClipboardConnection(input.connection);
const clearModels = await configureRemoteModelConnection(input.connection);
await recordInitOffered();
const terminal = new VirtualTerminal({ columns: 120, rows: 40 });
initTUIWithPair({ terminal, tui: new RunWieldTui(terminal) });
let lifecycle: InteractiveLifecycleHandle | undefined;
let sessionId = "";
const report = async () => {
    await terminal.flush();
    console.log(
        JSON.stringify({
            screen: terminal.getScreenText(),
            processing: lifecycle?.isProcessingSubmission() || false,
            sessionId,
        }),
    );
};
try {
    await startInteractiveSession(null, {
        remoteSessionControl: new RemoteSessionControl(input.connection),
        browser: NO_OPEN_BROWSER_PORT,
        onLifecycleReady: (handle) => (lifecycle = handle),
        onSessionReady: (id) => (sessionId = id),
        onSessionReplaced: (id) => (sessionId = id),
    });
    await report();
    while (true) {
        const next = await lines.read();
        if (next.done) break;
        const command: RemoteSubmitCommand = JSON.parse(next.value);
        if (command.close) break;
        if (command.text) terminal.typeText(command.text);
        terminal.input(command.key || "\r");
        const deadline = Date.now() + 5000;
        do {
            await new Promise((resolve) => setTimeout(resolve, 20));
            await terminal.flush();
        } while (
            Date.now() < deadline &&
            ((command.waitForIdle !== false && lifecycle?.isProcessingSubmission()) ||
                (command.expect && !terminal.getScreenText().includes(command.expect)))
        );
        await report();
    }
} finally {
    await lifecycle?.dispose();
    clearClipboard();
    clearModels();
    stopTUI();
}
