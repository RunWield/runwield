/** External Mnemoteca process capability used by Work Record indexing. */

export interface MnemotecaCommandResult {
    success: boolean;
    code: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
}

export interface WorkRecordMnemotecaCommandOptions {
    cwd?: string;
    env?: Record<string, string>;
}

export interface WorkRecordMnemotecaPort {
    run(args: string[], options?: WorkRecordMnemotecaCommandOptions): Promise<MnemotecaCommandResult>;
}

export const SYSTEM_WORK_RECORD_MNEMOTECA_PORT: WorkRecordMnemotecaPort = {
    run: (args, options) =>
        new Deno.Command("mnemoteca", {
            args,
            cwd: options?.cwd,
            env: options?.env,
            stdout: "piped",
            stderr: "piped",
        }).output(),
};
