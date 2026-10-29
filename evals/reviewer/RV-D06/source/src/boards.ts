import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Board } from "./model.ts";

async function loadBoards(root: string): Promise<Board[]> {
    return JSON.parse(await readFile(join(root, "boards.json"), "utf8"));
}
export async function readBoard(root: string, id: string): Promise<Board> {
    const board = (await loadBoards(root)).find((board) => board.id === id);
    if (!board) throw new Error("Board not found");
    return board;
}
export async function renameBoard(root: string, id: string, title: string): Promise<Board> {
    if (!title.trim()) throw new Error("A board title is required");
    const boards = await loadBoards(root);
    const board = boards.find((board) => board.id === id);
    if (!board) throw new Error("Board not found");
    board.title = title.trim();
    await writeFile(join(root, "boards.next.json"), JSON.stringify(boards) + "\n");
    await rename(join(root, "boards.next.json"), join(root, "boards.json"));
    return board;
}
