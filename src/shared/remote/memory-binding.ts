import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { resolveMemoryCollection } from "../memory-collection.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { listProjectsFromDisk, remoteProjectRoot } from "../session/file-session-storage.ts";
import { getRunWieldSessionsBaseDir } from "../session/root-session.js";
import type { ResolvedRemoteTarget } from "./target.ts";

export interface RemoteMemoryIdentity {
    key: string;
    collection: string;
    folder: string;
}

/** Memory deliberately excludes the host key; Session identity does not. */
export function remoteMemoryIdentity(target: ResolvedRemoteTarget): RemoteMemoryIdentity {
    const root = remoteProjectRoot(target);
    const hostname = target.host.hostname.toLowerCase();
    const key = JSON.stringify([hostname, target.host.user, target.host.port, root]);
    const folder = root.split("/").filter(Boolean).at(-1) || "default";
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return { key, folder, collection: `${folder}@${hostname}-${hash}` };
}

/** Ask only about saved local project folders, not similarly named Memory collections. */
export async function bindRemoteMemory(target: ResolvedRemoteTarget): Promise<string> {
    const identity = remoteMemoryIdentity(target);
    const directory = join(getHomeDir(), ".wld", "remote-memory-bindings");
    const path = join(directory, `${createHash("sha256").update(identity.key).digest("hex")}.json`);
    const read = async () => {
        const binding: { key: string; collection: string } = JSON.parse(await readFile(path, "utf8"));
        if (binding.key !== identity.key || typeof binding.collection !== "string" || !binding.collection) {
            throw new Error("Invalid saved remote Memory binding");
        }
        return binding.collection;
    };
    try {
        return await read();
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const matches = [
        ...new Set(
            listProjectsFromDisk(getRunWieldSessionsBaseDir())
                .filter((project) => !project.remote)
                .map((project) => resolvePrimaryCheckoutRoot(project.currentRoot))
                .filter((root) => basename(root) === identity.folder),
        ),
    ].sort();
    let collection = identity.collection;
    if (matches.length) {
        const question =
            `Is ${target.host.user}@${target.host.hostname}:${remoteProjectRoot(target)} the same project?\n` +
            matches.map((root, index) => `${index + 1}. Yes: ${root}`).join("\n") +
            `\n0. No: keep memories separate\nChoose 0–${matches.length}:`;
        const answer = globalThis.prompt(question);
        if (answer === null || !/^\d+$/.test(answer.trim())) throw new Error("Remote Memory choice canceled");
        const choice = Number(answer.trim());
        if (choice < 0 || choice > matches.length) throw new Error("Invalid remote Memory choice");
        if (choice) collection = await resolveMemoryCollection({ cwd: matches[choice - 1] });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${crypto.randomUUID()}.tmp`);
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify({ key: identity.key, collection }));
            await file.sync();
        } finally {
            await file.close();
        }
        // Publish once: concurrent connections reuse the first complete answer.
        try {
            await link(temporary, path);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        const folder = await open(directory, "r");
        try {
            await folder.sync();
        } finally {
            await folder.close();
        }
        return await read();
    } finally {
        await unlink(temporary);
    }
}
