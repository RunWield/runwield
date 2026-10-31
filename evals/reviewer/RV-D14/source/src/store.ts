import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryRecord } from "./model.ts";

export async function saveHistory(root: string, records: HistoryRecord[]): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "history.json"), JSON.stringify(records));
}

export async function listHistory(root: string): Promise<HistoryRecord[]> {
    try {
        return JSON.parse(await readFile(join(root, "history.json"), "utf8")) as HistoryRecord[];
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}
