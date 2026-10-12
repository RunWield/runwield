/** The native PTY boundary used by the real interactive installer fixtures. */
export interface FixtureTerminal {
    write(input: string): number;
    close(): void;
    setRawMode(enabled: boolean): void;
}
interface TerminalOptions {
    cols: number;
    rows: number;
    data(terminal: FixtureTerminal, data: Uint8Array): void;
}
interface TerminalProcessOptions {
    cwd: string;
    timeout: number;
    env?: NodeJS.ProcessEnv;
    terminal: TerminalOptions;
}
interface TerminalProcess {
    terminal: FixtureTerminal;
    exited: Promise<number>;
    kill(signal?: "SIGKILL" | "SIGTERM"): void;
}
export interface TerminalRuntime {
    spawn(command: string[], options: TerminalProcessOptions): TerminalProcess;
}
