import fsPromises from "node:fs/promises";
/**
 * @module shared/project-state
 * Shared project-state detection and user-facing text.
 */

import { join } from "node:path";

export const EMPTY_PROJECT_DIRECTORY_HEADER = "Empty directory detected";
export const EMPTY_PROJECT_DIRECTORY_WELCOME_BODY =
    "Tell RunWield what you’d like to build. You can ask for a specific kind of project, ask “help me choose a tech stack,” or ask “help me sharpen my idea for this project.”";
export const EMPTY_PROJECT_DIRECTORY_PROMPT_NOTE =
    "This RunWield session began in an Empty Project Directory. Treat this as greenfield work: there is no existing project architecture, conventions, validation command, or real Router-provided affected paths yet. When tech stack, product shape, or goals require a clear choice, defer to the user rather than inventing one.";
export const EMPTY_PROJECT_DIRECTORY_INIT_NOOP_BODY =
    "Nothing to initialize yet. This directory has no project files for RunWield to inspect. Add files or describe what you want to build; once the project has meaningful files, RunWield can initialize project context.";

/**
 * @param name
 * @returns {boolean}
 */
function isDotPrefixedSegment(name: string) {
    return name.startsWith(".");
}

/**
 * Return whether a directory has no meaningful project files.
 *
 * Meaningful files are regular, non-dot-prefixed, non-zero-size files reachable
 * only through non-dot-prefixed path segments. Dotfiles, dotfolders, empty
 * folders, zero-byte files, and symlinks are ignored so startup does not crash.
 * Read, iteration, and stat failures are treated conservatively as meaningful
 * because meaningful files may exist but could not be inspected.
 *
 * @param cwd
 * @returns {Promise<boolean>}
 */
export async function isEmptyProjectDirectory(cwd: string) {
    try {
        const rootInfo = await fsPromises.lstat(cwd);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    } catch {
        return false;
    }

    /**
     * @param dir
     * @returns {Promise<boolean>} true when a meaningful file is found
     */
    async function containsMeaningfulFile(dir: string) {
        let entries;
        try {
            entries = await fsPromises.opendir(dir);
        } catch {
            return true;
        }

        try {
            for await (const entry of entries) {
                if (isDotPrefixedSegment(entry.name)) continue;

                const path = join(dir, entry.name);
                let info;
                try {
                    info = await fsPromises.lstat(path);
                } catch {
                    return true;
                }

                if (info.isFile() && info.size > 0) return true;
                if (info.isDirectory() && !info.isSymbolicLink()) {
                    if (await containsMeaningfulFile(path)) return true;
                }
            }
        } catch {
            return true;
        }

        return false;
    }

    return !(await containsMeaningfulFile(cwd));
}
