import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { initRunWieldTheme } from "../theme/theme.ts";
import { createUiApi } from "./api.js";
import { SpinnerBlock } from "./blocks.js";
import stripAnsi from "strip-ansi";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";

export function createUiApiFixture() {
    initRunWieldTheme();
    const terminal = new VirtualTerminal({ columns: 120, rows: 40 });
    const tui = new TuiMainScreen(terminal);
    const messages = new Container();
    const interaction = new Container();
    const spinner = new SpinnerBlock();
    const accessory = new Container();
    const validation = new Container();
    const queued = new Container();
    tui.addChild(messages);
    tui.addChild(validation);
    tui.addChild(accessory);
    tui.addChild(queued);
    tui.addChild(interaction);
    tui.addChild(spinner);
    const uiAPI = createUiApi(null, tui, messages, spinner, accessory, validation, interaction, queued);
    tui.start();
    return {
        terminal,
        tui,
        uiAPI,
        messages,
        validation,
        queued,
        accessory,
        allText: () => stripAnsi(tui.render(120).join("\n")),
        text: () => messages.render(120).join("\n"),
        close() {
            uiAPI.dispose?.();
            tui.stop();
        },
    };
}
