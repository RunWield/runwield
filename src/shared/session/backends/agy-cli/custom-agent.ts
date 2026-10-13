import type { Stats } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import {
    chmod as fsChmod,
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "../../../../constants.js";

export interface AgyCustomAgentPaths {
    agentsRootPath: string;
    agentDirectoryPath: string;
    definitionPath: string;
}

export interface AgyCustomAgentOwnership {
    name: string;
    definition: string;
    agentsRootPath: string;
    agentDirectoryPath: string;
    definitionPath: string;
    createdAgentDirectory: boolean;
    createdDefinition: boolean;
}

export function assertRunWieldAgentName(name: string): void {
    if (!/^runwield-[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error("Agy custom agent name must match runwield-* and contain no path separators");
    }
}

export function resolveAgyCustomAgentPaths(name: string): AgyCustomAgentPaths {
    assertRunWieldAgentName(name);
    const agentsRootPath = join(getHomeDir(), ".gemini", "config", "agents");
    const agentDirectoryPath = join(agentsRootPath, name);
    return { agentsRootPath, agentDirectoryPath, definitionPath: join(agentDirectoryPath, "agent.md") };
}

async function lstatOrNull(path: string): Promise<Stats | null> {
    try {
        return await fsLstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
    try {
        await fsChmod(path, mode);
    } catch {
        // Best effort on platforms without chmod support.
    }
}

export async function materializeAgyCustomAgent(
    name: string,
    definition: string,
): Promise<AgyCustomAgentOwnership> {
    const trimmedDefinition = definition.trim();
    if (!trimmedDefinition) throw new Error("Agy custom agent definition is required");
    const paths = resolveAgyCustomAgentPaths(name);
    const existingRoot = await lstatOrNull(paths.agentsRootPath);
    if (existingRoot?.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link agents directory: ${paths.agentsRootPath}`);
    }
    if (existingRoot && !existingRoot.isDirectory()) {
        throw new Error(`Agy agents path is not a directory: ${paths.agentsRootPath}`);
    }
    await fsMkdir(paths.agentsRootPath, { recursive: true, mode: 0o700 });
    await chmodBestEffort(paths.agentsRootPath, 0o700);

    const existingAgentDirectory = await lstatOrNull(paths.agentDirectoryPath);
    if (existingAgentDirectory?.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link agent directory: ${paths.agentDirectoryPath}`);
    }
    if (existingAgentDirectory && !existingAgentDirectory.isDirectory()) {
        throw new Error(`Agy custom agent path is not a directory: ${paths.agentDirectoryPath}`);
    }
    const createdAgentDirectory = !existingAgentDirectory;
    if (createdAgentDirectory) await fsMkdir(paths.agentDirectoryPath, { mode: 0o700 });
    await chmodBestEffort(paths.agentDirectoryPath, 0o700);

    const existingDefinition = await lstatOrNull(paths.definitionPath);
    if (existingDefinition?.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link agent definition: ${paths.definitionPath}`);
    }
    if (existingDefinition) {
        if (!existingDefinition.isFile()) {
            throw new Error(`Agy custom agent definition path is not a file: ${paths.definitionPath}`);
        }
        const existingText = await fsReadFile(paths.definitionPath, "utf8");
        if (existingText !== definition) {
            throw new Error(`Agy custom agent already exists with different content: ${paths.definitionPath}`);
        }
        return {
            name,
            definition,
            agentsRootPath: paths.agentsRootPath,
            agentDirectoryPath: paths.agentDirectoryPath,
            definitionPath: paths.definitionPath,
            createdAgentDirectory,
            createdDefinition: false,
        };
    }

    await fsWriteFile(paths.definitionPath, definition, { flag: "wx", mode: 0o600 });
    await chmodBestEffort(paths.definitionPath, 0o600);
    return {
        name,
        definition,
        agentsRootPath: paths.agentsRootPath,
        agentDirectoryPath: paths.agentDirectoryPath,
        definitionPath: paths.definitionPath,
        createdAgentDirectory,
        createdDefinition: true,
    };
}

export async function verifyAgyCustomAgentOwnership(ownership: AgyCustomAgentOwnership): Promise<void> {
    const directoryInfo = await lstatOrNull(ownership.agentDirectoryPath);
    if (!directoryInfo || directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error("Agy custom agent directory is missing or invalid");
    }
    const definitionInfo = await lstatOrNull(ownership.definitionPath);
    if (!definitionInfo || definitionInfo.isSymbolicLink() || !definitionInfo.isFile()) {
        throw new Error("Agy custom agent definition is missing or invalid");
    }
    const currentText = await fsReadFile(ownership.definitionPath, "utf8");
    if (currentText !== ownership.definition) {
        throw new Error("Agy custom agent definition changed");
    }
}

export async function cleanupAgyCustomAgent(ownership: AgyCustomAgentOwnership): Promise<void> {
    if (ownership.createdDefinition) {
        const definitionInfo = await lstatOrNull(ownership.definitionPath);
        if (definitionInfo) {
            if (definitionInfo.isSymbolicLink() || !definitionInfo.isFile()) {
                throw new Error(
                    `Refusing cleanup because agent definition is no longer the owned file: ${ownership.definitionPath}`,
                );
            }
            const currentText = await fsReadFile(ownership.definitionPath, "utf8");
            if (currentText !== ownership.definition) {
                throw new Error(`Refusing cleanup because agent definition changed: ${ownership.definitionPath}`);
            }
            await fsRm(ownership.definitionPath);
        }
    }

    if (!ownership.createdAgentDirectory) return;
    const directoryInfo = await lstatOrNull(ownership.agentDirectoryPath);
    if (!directoryInfo) return;
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error(
            `Refusing cleanup because agent directory is no longer the owned directory: ${ownership.agentDirectoryPath}`,
        );
    }
    for await (const _entry of (await readdir(ownership.agentDirectoryPath))) {
        throw new Error(`Refusing cleanup because agent directory changed: ${ownership.agentDirectoryPath}`);
    }
    await rmdir(ownership.agentDirectoryPath);
}
