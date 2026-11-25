import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { ensurePrivateDir, openNativeFileLock, writeJsonAtomically } from "@runwield/resources/fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isWorkRecordId, type GeneratedWorkRecordSections } from "./documents.ts";
import { assertWorkRecordContainedPath } from "./paths.ts";

export interface WorkRecordLocation {
    kind: "import" | "copy";
    sourcePath: string;
    digest: string;
    repositoryId?: string;
    repositoryPath?: string;
}

export interface WorkRecordLocations {
    version: 1;
    projectId: string;
    personalOwner: string;
    recordId: string;
    locations: WorkRecordLocation[];
}

interface PreparedRecordCopy {
    kind: "plan" | "work-record";
    path: string;
    text: string;
}

export interface RecordingPreparation {
    version: 1;
    attemptId: string;
    recordId: string;
    createdAt: string;
    sections?: GeneratedWorkRecordSections;
    record?: PreparedRecordCopy;
    settled?: boolean;
}

const mutations = new AsyncLocalStorage<string>();

async function readOptionalFile(path: string) {
    try {
        if (!(await lstat(path)).isFile()) throw new Error(`Work Record evidence must be a regular file: ${path}`);
        return await readFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export function retainedFiles(identity: ProjectStoreIdentity, internal: string) {
    const home = identity.executionAccountHome;
    const lockPath = join(internal, "records.lock");
    const preparations = join(internal, "preparations");
    const recordingCreations = join(internal, "recording-creations");

    async function mutate<Result>(run: () => Promise<Result>): Promise<Result> {
        if (mutations.getStore() === lockPath) return await run();
        projects.home.assertStoreIdentity(identity);
        await assertWorkRecordContainedPath(home, lockPath);
        ensurePrivateDir(internal);
        const lock = openNativeFileLock(lockPath);
        try {
            await lock.lock(true);
            return await mutations.run(lockPath, run);
        } finally {
            lock.close();
        }
    }

    async function locationPath(recordId: string) {
        if (!/^[0-9a-f-]{36}$/i.test(recordId)) throw new Error("Invalid Work Record identity.");
        const path = join(internal, "locations", `${recordId.toLowerCase()}.json`);
        await assertWorkRecordContainedPath(home, path);
        return path;
    }

    async function readLocations(recordId: string): Promise<WorkRecordLocations | null> {
        projects.home.assertStoreIdentity(identity);
        const text = await readOptionalFile(await locationPath(recordId));
        if (text === null) return null;
        const value: WorkRecordLocations = JSON.parse(text);
        if (
            value.version !== 1 ||
            value.recordId.toLowerCase() !== recordId.toLowerCase() ||
            value.projectId !== identity.projectId ||
            value.personalOwner !== identity.personalOwner.identity ||
            !Array.isArray(value.locations)
        )
            throw new Error("Work Record location evidence belongs to another identity.");
        return value;
    }

    async function retainLocation(recordId: string, location: WorkRecordLocation): Promise<void> {
        await mutate(async () => {
            if (
                location.repositoryPath &&
                (!location.repositoryId ||
                    isAbsolute(location.repositoryPath) ||
                    location.repositoryPath.split(/[\\/]/).some((part) => !part || part === ".." || part === "."))
            )
                throw new Error("Unsafe repository Work Record location.");
            const value: WorkRecordLocations = (await readLocations(recordId)) ?? {
                version: 1,
                projectId: identity.projectId,
                personalOwner: identity.personalOwner.identity,
                recordId,
                locations: [],
            };
            if (value.locations.some((prior) => JSON.stringify(prior) === JSON.stringify(location))) return;
            value.locations.push(location);
            writeJsonAtomically(await locationPath(recordId), value);
        });
    }

    async function forgetLocations(recordId: string) {
        await mutate(async () => {
            await rm(await locationPath(recordId), { force: true });
        });
    }

    async function preparationPath(attemptId: string, directory = preparations) {
        if (!/^[a-zA-Z0-9_-]+$/.test(attemptId)) throw new Error("Invalid recording attempt identity.");
        const path = join(directory, `${attemptId}.json`);
        await assertWorkRecordContainedPath(home, path);
        return path;
    }

    async function readPreparation(attemptId: string, directory = preparations): Promise<RecordingPreparation | null> {
        projects.home.assertStoreIdentity(identity);
        const text = await readOptionalFile(await preparationPath(attemptId, directory));
        if (text === null) return null;
        if (!text.trim()) throw new Error("Recording preparation is empty.");
        const state: RecordingPreparation = JSON.parse(text);
        if (
            state.version !== 1 ||
            state.attemptId !== attemptId ||
            typeof state.recordId !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(state.recordId) ||
            (state.settled !== undefined && typeof state.settled !== "boolean")
        )
            throw new Error("Recording preparation identity changed.");
        return state;
    }

    async function writePreparation(state: RecordingPreparation): Promise<void> {
        await mutate(async () => {
            const prior = await readPreparation(state.attemptId);
            if (!prior || prior.recordId !== state.recordId || prior.createdAt !== state.createdAt)
                throw new Error("Recording preparation identity changed.");
            writeJsonAtomically(await preparationPath(state.attemptId), state);
        });
    }

    async function reservePreparationIn(
        directory: string,
        attemptId: string,
        checkpointedRecordId?: string,
    ): Promise<RecordingPreparation> {
        if (checkpointedRecordId !== undefined && !isWorkRecordId(checkpointedRecordId))
            throw new Error("Invalid Work Record identity in the Recorder checkpoint.");
        return await mutate(async () => {
            const prior = await readPreparation(attemptId, directory);
            if (prior) {
                if (checkpointedRecordId && prior.recordId.toLowerCase() !== checkpointedRecordId.toLowerCase())
                    throw new Error("Recording preparation identity changed.");
                return prior;
            }
            const state: RecordingPreparation = {
                version: 1,
                attemptId,
                recordId: checkpointedRecordId ?? randomUUID(),
                createdAt: new Date().toISOString(),
            };
            writeJsonAtomically(await preparationPath(attemptId, directory), state);
            return state;
        });
    }

    async function listPreparationAttempts(): Promise<string[]> {
        projects.home.assertStoreIdentity(identity);
        await assertWorkRecordContainedPath(home, preparations);
        try {
            return (await readdir(preparations))
                .filter((file) => file.endsWith(".json"))
                .map((file) => file.slice(0, -5));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
        }
    }

    return {
        mutate,
        readLocations,
        retainLocation,
        forgetLocations,
        readPreparation,
        reservePreparation: (attemptId: string, checkpointedRecordId?: string) =>
            reservePreparationIn(preparations, attemptId, checkpointedRecordId),
        readRecordingCreation: (attemptId: string) => readPreparation(attemptId, recordingCreations),
        reserveRecordingCreation: (attemptId: string, checkpointedRecordId?: string) =>
            reservePreparationIn(recordingCreations, attemptId, checkpointedRecordId),
        writePreparation,
        listPreparationAttempts,
    };
}
