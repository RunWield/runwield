/** Native Git Bash access for tests of the project's actual POSIX scripts. */
import { platform } from "node:process";
import { findWindowsBashPath } from "../src/shared/windows-bash.ts";

export function bashFixtureExecutable(): string {
    if (platform !== "win32") return "/bin/bash";
    const executable = findWindowsBashPath();
    if (!executable) throw new Error("Git Bash is required to test the POSIX scripts on Windows");
    return executable;
}

/** Drive-qualified Windows paths need MSYS spelling inside a colon-separated PATH. */
export function bashFixturePath(path: string): string {
    if (platform !== "win32") return path;
    return path.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
}

export function quoteBashFixture(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
