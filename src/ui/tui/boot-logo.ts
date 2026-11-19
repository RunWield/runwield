/**
 * @module ui/tui/boot-logo
 *
 * Renders the RunWield boot banner with a block W logo centered on screen.
 * The logo is tinted with the theme's "teal" color. The square on the
 * bottom right blinks like a cursor.
 * Title line keeps its current accent/dim colors.
 */

import { Spacer, Text } from "@earendil-works/pi-tui";
import { getTUI } from "./tui.ts";
import { theme } from "../theme/theme.ts";

interface BootLogoContainer {
    addChild(child: unknown): void;
}

const logo = [
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓                  ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓      ▓▓▓▓▓▓      ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓      ▓▓▓▓▓▓      ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓      ▓▓▓▓▓▓      ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓",
    "▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓",
];

const dotOff = [
    "▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓",
    " ▓▓▓▓▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓▓▓▓▓",
    " ▓▓▓▓▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓▓▓▓▓",
    "   ▓▓▓▓▓▓▓            ▓▓▓▓▓▓▓",
];

const dotOn = [
    "▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓       ▓▓▓▓▓▓▓",
    " ▓▓▓▓▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓▓▓▓▓        ▓▓▓▓▓▓▓",
    " ▓▓▓▓▓▓▓▓▓▓▓▓      ▓▓▓▓▓▓▓▓▓▓▓▓        ▓▓▓▓▓▓▓",
    "   ▓▓▓▓▓▓▓            ▓▓▓▓▓▓▓          ▓▓▓▓▓▓▓",
];

let blinkInterval: ReturnType<typeof setInterval> | undefined;
const dot: Text[] = [];
let activeTui: { requestRender?: () => void } | null = null;

/**
 * Build a centered ASCII logo banner and insert it into the TUI container.
 */
export function renderBootLogo(container: BootLogoContainer) {
    endBlink();
    const { tui, terminal } = getTUI();
    activeTui = tui;

    terminal.clearFromCursor();
    terminal.clearScreen();

    container.addChild(new Spacer(1));
    container.addChild(new Spacer(1));

    for (const line of logo) {
        container.addChild(new Text(theme.fg("mdCode", line), 0, 0));
    }

    for (const line of dotOn) {
        const text = new Text(theme.fg("mdCode", line), 0, 0);
        dot.push(text);
        container.addChild(text);
    }

    // Blank lines for spacing
    container.addChild(new Spacer(1));

    // Start the blinking animation
    let visible = true;
    blinkInterval = setInterval(() => {
        visible = !visible;
        const lines = visible ? dotOn : dotOff;
        for (let i = 0; i < dot.length; i++) {
            dot[i].setText(theme.fg("mdCode", lines[i]));
        }

        tui.requestRender();
    }, 1300);
    if (typeof blinkInterval.unref === "function") blinkInterval.unref();
}

export function endBlink() {
    if (blinkInterval !== undefined) {
        clearInterval(blinkInterval);
        blinkInterval = undefined;
    }

    for (let i = 0; i < dot.length; i++) {
        dot[i].setText(theme.fg("mdCode", dotOn[i]));
    }

    activeTui?.requestRender?.();
    dot.length = 0;
    activeTui = null;
}
