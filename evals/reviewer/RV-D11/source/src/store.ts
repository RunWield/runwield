import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Note } from "./model.ts";

export async function saveNotes(root: string, notes: Note[]): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "notes.json"), JSON.stringify(notes));
}

export async function listNotes(root: string): Promise<Note[]> {
    try {
        return JSON.parse(await readFile(join(root, "notes.json"), "utf8")) as Note[];
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}
