import { Container, isViewportTUI, Key, matchesKey, ScrollView, Text, type TUI, VStack } from "@earendil-works/pi-tui";
import type { SavedRemoteSession } from "../../shared/remote/laptop-session-control.ts";
import { parseRemoteSessionTranscript } from "../../shared/remote/session-protocol.ts";
import { createReplayEvents } from "../../shared/session/session-transcript-projection.js";
import { createUiApi } from "./api.js";
import { SpinnerBlock } from "./blocks.js";
import { createTuiDisplayConsumer } from "./runtime-display.ts";
import { theme } from "../theme/theme.js";

function safeLabel(value: string): string {
    // deno-lint-ignore no-control-regex -- Durable host labels must not send terminal controls.
    return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").trim();
}

export function remoteHistoryFooter(targetLabel: string): string {
    const target = safeLabel(targetLabel);
    return `Saved on ${target}. Connect with wld remote ${target}, then /resume. · q exit`;
}

/** A laptop-only display surface. No Runtime, Session store, writer, or connection is created. */
export async function showRemoteHistory(tui: TUI, saved: SavedRemoteSession[]): Promise<void> {
    const messages = new Container();
    const interaction = new Container();
    const footer = new Text(theme.fg("dim", "Saved remote Sessions · ↑/↓ choose · Enter open · Esc exit"), 0, 0);
    const uiAPI = createUiApi(null, tui, messages, new SpinnerBlock(), undefined, undefined, interaction);
    const display = createTuiDisplayConsumer(uiAPI);
    const transcript = new ScrollView(messages, { primary: true, scrollbar: "auto" });
    if (isViewportTUI(tui)) {
        tui.setLayoutRoot(
            new VStack([
                { component: transcript, basis: 0, grow: 1, minSize: 1 },
                { component: interaction, basis: "auto", shrink: 0 },
                { component: footer, basis: "auto", shrink: 0 },
            ]),
        );
    } else {
        tui.addChild(messages);
        tui.addChild(interaction);
        tui.addChild(footer);
    }
    let removeExit = () => {};
    try {
        const id = await uiAPI.promptSelect(
            "Saved remote Sessions",
            saved.map((session) => ({
                value: session.summary.id,
                label: safeLabel(session.summary.name || session.summary.firstMessage || "Untitled Session"),
                description: `${safeLabel(session.targetLabel)} · ${safeLabel(session.summary.modified)}`,
            })),
            { persistResult: false },
        );
        const selected = saved.find((session) => session.summary.id === id);
        if (!selected) return;
        messages.clear();
        for (const event of createReplayEvents(selected.summary.id, parseRemoteSessionTranscript(selected.contents))) {
            display.consume(event);
        }
        footer.setText(theme.fg("dim", remoteHistoryFooter(selected.targetLabel)));
        tui.setFocus(transcript);
        tui.requestRender();
        await new Promise<void>((resolve) => {
            removeExit = tui.addInputListener((data) => {
                if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
                    resolve();
                    return { consume: true };
                }
                // The focused scroll surface handles navigation. There is no editor.
            });
        });
    } finally {
        removeExit();
        display.dispose();
        uiAPI.dispose?.();
        if (isViewportTUI(tui)) tui.setLayoutRoot(undefined);
        else {
            tui.removeChild(messages);
            tui.removeChild(interaction);
            tui.removeChild(footer);
        }
    }
}
