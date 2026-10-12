import { cleanupStoredPublication, loadPublicationAttempt } from "../publication-machine.ts";

const [projectRoot, boundary] = Deno.args;
const attempt = await loadPublicationAttempt(projectRoot, "attempt-demo");
if (!attempt) throw new Error("Publication fixture is missing");

// Interrupt at the real Git subprocess boundary, without replacing publication
// storage, transition logic, or journal writes.
const NativeCommand = Deno.Command;
Deno.Command = class extends NativeCommand {
    private stop: boolean;
    constructor(command: string | URL, options: Deno.CommandOptions = {}) {
        super(command, options);
        const args = options.args || [];
        this.stop = command === "git" &&
            (boundary === "before"
                ? args[0] === "merge-base"
                : boundary === "after" && args[0] === "worktree" && args[1] === "remove");
    }
    override output(): Promise<Deno.CommandOutput> {
        if (this.stop) Deno.kill(Deno.pid, "SIGKILL");
        return super.output();
    }
};
await cleanupStoredPublication(projectRoot, attempt);
