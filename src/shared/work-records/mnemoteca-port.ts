import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
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
    run: async (args, options) => {
        const result = await captureForegroundProcess("mnemoteca", {
            args,
            cwd: options?.cwd ?? getCwd(),
            env: options?.env,
        });
        return { ...result, success: result.code === 0 };
    },
};
