import { spawn } from "node:child_process";

export interface TransitionCommand {
    executable: string;
    args: string[];
}
export async function runCommand(command: TransitionCommand): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command.executable, command.args, { stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Transition command failed (${code})`));
        });
    });
}
