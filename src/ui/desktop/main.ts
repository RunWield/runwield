import { app, protocol } from "electron";
import { isAbsolute } from "node:path";
import { startDesktopSupervisor } from "./supervisor.ts";

function argument(name: string): string {
    const index = process.argv.indexOf(name);
    return index < 0 ? "" : process.argv[index + 1] || "";
}
const projectArgument = argument("--project");
const bun = argument("--bun");
const cli = argument("--cli");
if (![bun, cli].every((path) => isAbsolute(path)) || (projectArgument && !isAbsolute(projectArgument)))
    throw new Error("Use desktop:dev with the source runtime launcher and an optional absolute Project candidate.");
const inspector = argument("--cdp-port");
if (inspector) {
    if (!/^\d+$/.test(inspector) || Number(inspector) < 1024 || Number(inspector) > 65535)
        throw new Error("Use a development inspection port between 1024 and 65535.");
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
    app.commandLine.appendSwitch("remote-debugging-port", inspector);
}
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
    { scheme: "runwield", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// Do not top-level await startup: Electron waits for ESM evaluation before emitting ready.
void startDesktopSupervisor({ bun, cli, projectArgument, hidden: process.argv.includes("--hidden") }).catch(
    (error: Error) => {
        console.error(error);
        app.exit(1);
    },
);
