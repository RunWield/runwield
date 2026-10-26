import { spawn } from "node:child_process";
import type { CommandResult } from "./model.ts";

export class Command {
    private child;
    readonly result: Promise<CommandResult>;

    get pid(): number | undefined {
        return this.child.pid;
    }

    constructor(executable: string, args: string[]) {
        this.child = spawn(executable, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        this.result = new Promise((resolve, reject) => {
            let output = "";
            this.child.stdout.on("data", (chunk) => {
                output += chunk.toString();
            });
            this.child.stderr.on("data", (chunk) => {
                output += chunk.toString();
            });
            this.child.once("error", reject);
            this.child.once("close", (code) => resolve({ status: code === 0 ? "passed" : "failed", code, output }));
        });
    }
}
