import process from "node:process";
import { writeSync } from "node:fs";
import { AGENT_MASCOT_ALIASES, animations, mascotRoleForAgent, ROLES, terminalLines } from "./sprites.ts";

const requested = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "reviewer";
const parent = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--parent="))
    ?.slice("--parent=".length);
const animation = animations.find((item) => item.role === mascotRoleForAgent(requested, parent));
if (!animation) {
    console.error(
        requested === "delegated"
            ? "Delegated agents require --parent=<agent> so they can inherit its mascot."
            : `Choose a role: ${[...ROLES, ...Object.keys(AGENT_MASCOT_ALIASES)].join(", ")}`,
    );
    process.exit(1);
}
const write = (text: string) => writeSync(process.stdout.fd, text);
const snapshot = process.argv.slice(2).includes("--snapshot") || !process.stdout.isTTY;
if (snapshot) {
    console.log(terminalLines(animation.frames[0].pixels).join("\n"));
    console.log(`${animation.role} · 20 columns × 9 rows`);
} else {
    const cyclesArg = process.argv.slice(2).find((arg) => arg.startsWith("--cycles="));
    const cycles = cyclesArg ? Math.max(1, Number(cyclesArg.split("=")[1]) || 1) : Infinity;
    let stopped = false;
    const stop = () => {
        stopped = true;
    };
    process.on("SIGINT", stop);
    write("\x1b[?25l");
    try {
        for (let cycle = 0; cycle < cycles && !stopped; cycle++) {
            for (const frame of animation.frames) {
                if (stopped) break;
                write(terminalLines(frame.pixels).join("\n") + `\n${animation.role} · thinking (Ctrl+C to stop)\n`);
                await new Promise((resolve) => setTimeout(resolve, frame.duration));
                write("\x1b[10A\r");
            }
        }
        write(terminalLines(animation.idle).join("\n") + `\n\x1b[2K${animation.role} · idle\n`);
    } finally {
        process.off("SIGINT", stop);
        write("\x1b[?25h");
    }
}
