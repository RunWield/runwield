import { listNotes } from "./store.ts";

export async function noteTitles(root: string): Promise<string[]> {
    return (await listNotes(root)).map((note) => note.title);
}
