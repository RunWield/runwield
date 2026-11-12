import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { desktopBuild, desktopElectron, desktopRoot, requireDesktopArtifacts } from "./desktop-paths.ts";

await requireDesktopArtifacts();
const index = process.argv.indexOf("--project");
const input = index < 0 ? "" : process.argv[index + 1] || "";
if (input && !isAbsolute(input)) throw new Error("The optional Project candidate must be absolute.");
const args = [join(desktopBuild, "main.mjs"), "--bun", process.execPath, "--cli", join(desktopRoot, "src/cli.ts")];
if (input) args.push("--project", input);
const inspect = process.argv.indexOf("--cdp-port");
if (inspect >= 0) args.push("--cdp-port", process.argv[inspect + 1] || "");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn((await desktopElectron()).executable, args, { cwd: desktopRoot, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});
child.once("exit", (code) => {
    process.exitCode = code ?? 1;
});
