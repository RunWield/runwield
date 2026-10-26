import { readFile, writeFile } from "node:fs/promises";

export async function writeSummary(path: string, text: string): Promise<void> {
    await writeFile(path, text, "utf8");
}

export async function readSummary(path: string): Promise<string> {
    return readFile(path, "utf8");
}
