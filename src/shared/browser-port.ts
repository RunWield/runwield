import { captureForegroundProcess } from "./captured-process.ts";
import { getCwd } from "../constants.js";
import process from "node:process";
/** External capability for asking the operating system to open a URL. */
export interface BrowserPort {
    open(url: string): Promise<boolean>;
}

export const SYSTEM_BROWSER_PORT: BrowserPort = {
    async open(url: string): Promise<boolean> {
        const launcher = process.platform === "darwin"
            ? { command: "open", args: [url] }
            : process.platform === "win32"
            ? { command: "cmd", args: ["/c", "start", "", url] }
            : { command: "xdg-open", args: [url] };

        try {
            await captureForegroundProcess(launcher.command, { args: launcher.args, cwd: getCwd() });
            return true;
        } catch {
            return false;
        }
    },
};

export const NO_OPEN_BROWSER_PORT: BrowserPort = {
    open: () => Promise.resolve(false),
};
