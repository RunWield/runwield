const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

export type TerminalFocusState = "unknown" | "focused" | "unfocused";

export type TerminalSize = {
    columns: number;
    rows: number;
};

export type TerminalInputHandler = (data: string) => void;
export type TerminalResizeHandler = (size: TerminalSize) => void;

export interface FocusReportingTerminal {
    write(data: string): void;
    start(onInput: TerminalInputHandler, onResize?: TerminalResizeHandler): void;
}

export interface TerminalFocusStateOwner {
    activate(): void;
    getState(): TerminalFocusState;
    filterInput(data: string): string;
    dispose(): void;
}

type FocusFilterResult = {
    filtered: string;
    pending: string;
    nextState: TerminalFocusState;
};

interface MouseSequenceRecovery {
    process(data: string): void;
    dispose(): void;
}

const ESC = "\x1b";
const SGR_MOUSE_PREFIX = "\x1b[<";
// deno-lint-ignore no-control-regex
const SGR_MOUSE_SEQUENCE = /^\x1b\[<\d+;\d+;\d+[Mm]$/;
const MOUSE_SEQUENCE_TIMEOUT_MS = 60;

let currentTerminalFocusState: TerminalFocusStateOwner | null = null;

export function getCurrentTerminalFocusState(): TerminalFocusState {
    return currentTerminalFocusState?.getState() ?? "unknown";
}

export function setCurrentTerminalFocusState(owner: TerminalFocusStateOwner | null): void {
    currentTerminalFocusState = owner;
}

export function createTerminalFocusStateOwner(
    terminal: Pick<FocusReportingTerminal, "write">,
    activateImmediately = true,
): TerminalFocusStateOwner {
    let state: TerminalFocusState = "unknown";
    let pendingInput = "";
    let active = false;
    let disposed = false;

    const owner = {
        activate(): void {
            if (active || disposed) return;
            active = true;
            terminal.write(ENABLE_FOCUS_REPORTING);
        },
        getState(): TerminalFocusState {
            return state;
        },
        filterInput(data: string): string {
            const result = filterFocusReportInput(pendingInput + data, state);
            pendingInput = result.pending;
            state = result.nextState;
            return result.filtered;
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (active) terminal.write(DISABLE_FOCUS_REPORTING);
            if (currentTerminalFocusState === owner) {
                currentTerminalFocusState = null;
            }
        },
    } satisfies TerminalFocusStateOwner;

    if (activateImmediately) owner.activate();
    return owner;
}

export function installTerminalFocusState(
    terminal: FocusReportingTerminal,
    onFocus?: () => void,
    activateImmediately = true,
): TerminalFocusStateOwner {
    const originalStart = terminal.start.bind(terminal);
    const owner = createTerminalFocusStateOwner(terminal, activateImmediately);
    let mouseSequenceRecovery: MouseSequenceRecovery | undefined;
    terminal.start = (onInput: TerminalInputHandler, onResize?: TerminalResizeHandler): void => {
        mouseSequenceRecovery = createMouseSequenceRecovery(onInput);
        originalStart((data: string) => {
            const previousState = owner.getState();
            const filtered = owner.filterInput(data);
            if (previousState !== "focused" && owner.getState() === "focused") onFocus?.();
            if (filtered.length > 0) mouseSequenceRecovery?.process(filtered);
        }, onResize);
    };
    const disposeOwner = owner.dispose.bind(owner);
    const installedOwner: TerminalFocusStateOwner = {
        activate: () => owner.activate(),
        getState: () => owner.getState(),
        filterInput: (data) => owner.filterInput(data),
        dispose: () => {
            mouseSequenceRecovery?.dispose();
            if (currentTerminalFocusState === installedOwner) {
                currentTerminalFocusState = null;
            }
            disposeOwner();
        },
    };
    setCurrentTerminalFocusState(installedOwner);
    return installedOwner;
}

function createMouseSequenceRecovery(forwardInput: TerminalInputHandler): MouseSequenceRecovery {
    let pending = "";
    let discardedMouseSequence = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = (): void => {
        if (!timer) return;
        clearTimeout(timer);
        timer = undefined;
    };
    const flushPendingInput = (): void => {
        const input = pending;
        pending = "";
        clearTimer();
        if (input.startsWith(SGR_MOUSE_PREFIX)) {
            if (isPartialSgrMouseSequence(input)) discardedMouseSequence = input;
            return;
        }
        if (input) forwardInput(input);
    };
    const scheduleFlush = (): void => {
        clearTimer();
        timer = setTimeout(flushPendingInput, MOUSE_SEQUENCE_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
    };
    const discardMouseSuffix = (character: string): boolean => {
        if (!discardedMouseSequence) return false;
        const sequence = discardedMouseSequence + character;
        if (SGR_MOUSE_SEQUENCE.test(sequence)) {
            discardedMouseSequence = "";
            return true;
        }
        if (isPartialSgrMouseSequence(sequence)) {
            discardedMouseSequence = sequence;
            return true;
        }
        discardedMouseSequence = "";
        return false;
    };

    return {
        process(data: string): void {
            if (
                !pending &&
                !discardedMouseSequence &&
                data !== ESC &&
                data !== `${ESC}[` &&
                !data.startsWith(SGR_MOUSE_PREFIX)
            ) {
                forwardInput(data);
                return;
            }
            for (const character of data) {
                if (discardMouseSuffix(character)) continue;
                if (!pending) {
                    if (character === ESC) {
                        pending = ESC;
                        scheduleFlush();
                    } else {
                        forwardInput(character);
                    }
                    continue;
                }
                if (pending === ESC) {
                    if (character === "[") {
                        pending += character;
                        scheduleFlush();
                    } else {
                        const input = pending + character;
                        pending = "";
                        clearTimer();
                        forwardInput(input);
                    }
                    continue;
                }
                pending += character;
                const code = character.charCodeAt(0);
                if (code >= 0x40 && code <= 0x7e) {
                    const input = pending;
                    pending = "";
                    clearTimer();
                    if (!input.startsWith(SGR_MOUSE_PREFIX) || SGR_MOUSE_SEQUENCE.test(input)) {
                        forwardInput(input);
                    }
                } else {
                    scheduleFlush();
                }
            }
        },
        dispose(): void {
            pending = "";
            discardedMouseSequence = "";
            clearTimer();
        },
    };
}

function isPartialSgrMouseSequence(data: string): boolean {
    if (!data.startsWith(SGR_MOUSE_PREFIX)) return false;
    const fields = data.slice(SGR_MOUSE_PREFIX.length).split(";");
    if (fields.length > 3) return false;
    return fields.every((field, index) => (index === fields.length - 1 ? /^\d*$/.test(field) : /^\d+$/.test(field)));
}

function filterFocusReportInput(data: string, initialState: TerminalFocusState): FocusFilterResult {
    let nextState = initialState;
    let filtered = "";
    for (let index = 0; index < data.length;) {
        if (data.startsWith(FOCUS_IN, index)) {
            nextState = "focused";
            index += FOCUS_IN.length;
            continue;
        }
        if (data.startsWith(FOCUS_OUT, index)) {
            nextState = "unfocused";
            index += FOCUS_OUT.length;
            continue;
        }
        const rest = data.slice(index);
        if (isPartialFocusReport(rest)) {
            return { filtered, pending: rest, nextState };
        }
        filtered += data[index];
        index += 1;
    }
    return { filtered, pending: "", nextState };
}

function isPartialFocusReport(data: string): boolean {
    return data.length > 1 && (FOCUS_IN.startsWith(data) || FOCUS_OUT.startsWith(data));
}
