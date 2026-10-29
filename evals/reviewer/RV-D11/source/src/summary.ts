import type { Note, Summary } from "./model.ts";

export function summarize(notes: Note[]): Summary {
    return { count: notes.length, titles: notes.map((note) => note.title) };
}
