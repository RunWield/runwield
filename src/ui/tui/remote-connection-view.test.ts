import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { parseRemoteConnectionViewConfig, showRemoteConnectionView } from "./remote-connection-view.ts";

const config = {
    host: "build-server",
    cwd: "/srv/project",
    status: "Connected",
    trust: "SSH verified",
    readiness: "Not ready for work",
};

test("remote view rejects invalid configuration before terminal startup", () => {
    assertThrows(() => parseRemoteConnectionViewConfig(JSON.stringify({ ...config, host: 17 })), Error);
    assertThrows(() => parseRemoteConnectionViewConfig("[1,2]"), Error);
});

test("remote view shows connection facts without a chat editor", async () => {
    const terminal = new VirtualTerminal();
    const tui = new TuiMainScreen(terminal);
    const finished = showRemoteConnectionView(tui, config);
    try {
        tui.start();
        tui.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await terminal.flush();
        const screen = terminal.getScreenText();
        for (const fact of Object.values(config)) assertStringIncludes(screen, fact);
        assertEquals(screen.includes("Chat"), false);
        terminal.input("q");
        await finished;
    } finally {
        tui.stop();
    }
});

test("remote view consumes other keys and accepts Ctrl-C and Ctrl-D for exit", async () => {
    for (const exitKey of ["\x03", "\x04"]) {
        const terminal = new VirtualTerminal();
        const tui = new TuiMainScreen(terminal);
        const finished = showRemoteConnectionView(tui, config);
        try {
            tui.start();
            terminal.input("x");
            terminal.input("\r");
            terminal.input("\x1b[200~do not submit\x1b[201~");
            let exited = false;
            void finished.then(() => {
                exited = true;
            });
            await Promise.resolve();
            assertEquals(exited, false);
            terminal.input(exitKey);
            await finished;
        } finally {
            tui.stop();
        }
    }
});

test("remote view treats remote text as data, not terminal controls", async () => {
    const terminal = new VirtualTerminal();
    const tui = new TuiMainScreen(terminal);
    const finished = showRemoteConnectionView(tui, { ...config, host: "host\x1b[31m\nspoof" });
    try {
        tui.start();
        tui.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await terminal.flush();
        assertStringIncludes(terminal.getScreenText(), "host [31m spoof");
        terminal.input("q");
        await finished;
    } finally {
        tui.stop();
    }
});
