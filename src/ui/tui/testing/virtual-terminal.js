/**
 * @module ui/tui/testing/virtual-terminal
 * @xterm/headless-backed implementation of pi-tui's Terminal surface.
 */

import xtermHeadless from "@xterm/headless";

const { Terminal: HeadlessTerminal } = xtermHeadless;

/**
 * @typedef {Object} VirtualTerminalOptions
 * @property {number} [columns]
 * @property {number} [rows]
 */

/**
 * Test Terminal implementation compatible with the methods pi-tui calls on
 * ProcessTerminal. It never touches process stdin/stdout; input is injected by
 * tests and output is rendered into an xterm headless buffer.
 */
export class VirtualTerminal {
    /** @param {VirtualTerminalOptions} [options] */
    constructor(options = {}) {
        this._columns = options.columns || 80;
        this._rows = options.rows || 24;
        this._xterm = new HeadlessTerminal({
            cols: this._columns,
            rows: this._rows,
            allowProposedApi: true,
        });
        /** @type {((data: string) => void) | null} */
        this._onInput = null;
        /** @type {((size: { columns: number, rows: number }) => void) | null} */
        this._onResize = null;
        /** @type {Promise<void>[]} */
        this._pendingWrites = [];
        this.writes = "";
        this.started = false;
        this.stopped = false;
        this.title = "";
        this.progress = null;
        this.kittyProtocolActive = false;
        this.modifyOtherKeysActive = false;
    }

    get columns() {
        return this._columns;
    }

    get rows() {
        return this._rows;
    }

    /**
     * @param {(data: string) => void} onInput
     * @param {(size: { columns: number, rows: number }) => void} [onResize]
     */
    start(onInput, onResize) {
        this._onInput = onInput;
        this._onResize = onResize || null;
        this.started = true;
        this.stopped = false;
    }

    stop() {
        this._onInput = null;
        this._onResize = null;
        this.stopped = true;
    }

    /** @param {string} data */
    write(data) {
        this.writes += data;
        this._pendingWrites.push(
            new Promise((resolve) => {
                // Only xterm's callback proves the viewport consumed this write.
                // A timer can expire while parsing is still queued on a busy runner.
                this._xterm.write(data, resolve);
            }),
        );
    }

    /** @param {string} data */
    input(data) {
        if (!this._onInput) throw new Error("Virtual terminal has not been started.");
        this._onInput(data);
    }

    /** @param {string} text */
    typeText(text) {
        for (const char of text) this.input(char);
    }

    pressEnter() {
        this.input("\r");
    }

    pressEscape() {
        this.input("\x1b");
    }

    pressCtrlC() {
        this.input("\x03");
    }

    /** @param {number} columns @param {number} rows */
    resize(columns, rows) {
        this._columns = columns;
        this._rows = rows;
        this._xterm.resize(columns, rows);
        this._onResize?.({ columns, rows });
    }

    async flush() {
        while (this._pendingWrites.length) {
            const pending = this._pendingWrites.splice(0);
            await Promise.all(pending);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    getViewportLines() {
        const buffer = this._xterm.buffer.active;
        const viewportY = Number(buffer.viewportY || 0);
        /** @type {string[]} */
        const lines = [];
        for (let i = 0; i < this._rows; i++) {
            lines.push(buffer.getLine(viewportY + i)?.translateToString(true) || "");
        }
        return lines;
    }

    getScreenText() {
        return normalizeScreenText(this.getViewportLines().join("\n"));
    }

    /** @param {number} row @param {number} column */
    hasDefaultBackground(row, column) {
        const buffer = this._xterm.buffer.active;
        const cell = buffer.getLine(Number(buffer.viewportY || 0) + row)?.getCell(column);
        return cell?.isBgDefault() ?? true;
    }

    getScrollbackText() {
        return normalizeScreenText(this.writes);
    }

    clearLine() {
        this.write("\x1b[2K");
    }

    clearFromCursor() {
        this.write("\x1b[J");
    }

    clearScreen() {
        this.write("\x1b[2J\x1b[H");
    }

    /** @param {number} row @param {number} [col] */
    moveBy(row, col = 0) {
        if (row > 0) this.write(`\x1b[${row}B`);
        if (row < 0) this.write(`\x1b[${Math.abs(row)}A`);
        if (col > 0) this.write(`\x1b[${col}C`);
        if (col < 0) this.write(`\x1b[${Math.abs(col)}D`);
    }

    hideCursor() {
        this.write("\x1b[?25l");
    }

    showCursor() {
        this.write("\x1b[?25h");
    }

    /** @param {string} title */
    setTitle(title) {
        this.title = title;
    }

    /** @param {boolean | number | null} progress */
    setProgress(progress) {
        this.progress = progress;
    }

    clearProgressInterval() {
        this.progress = null;
        return false;
    }

    async drainInput() {}
    enableModifyOtherKeys() {
        this.modifyOtherKeysActive = true;
    }
    disableModifyOtherKeys() {
        this.modifyOtherKeysActive = false;
    }
    enableWindowsVTInput() {}
}

/** @param {string} text */
export function normalizeScreenText(text) {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const oscPattern = new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, "g");
    const csiPattern = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g");
    return text
        .replace(oscPattern, "")
        .replace(csiPattern, "")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n+$/g, "");
}
