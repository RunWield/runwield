import { readFile, writeFile } from "node:fs/promises";
import type { PublicationAttempt } from "./model.ts";

export async function readAttempt(path: string): Promise<PublicationAttempt> {
    return JSON.parse(await readFile(path, "utf8"));
}

export async function saveAttempt(path: string, attempt: PublicationAttempt): Promise<void> {
    await writeFile(path, JSON.stringify(attempt, null, 2) + "\n");
}
