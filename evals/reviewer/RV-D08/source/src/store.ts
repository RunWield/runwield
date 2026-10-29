import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { State } from "./model.ts";

export class Store {
    constructor(private root: string) {}
    async read(): Promise<State> {
        try {
            return JSON.parse(await readFile(join(this.root, "state.json"), "utf8")) as State;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return { tasks: [], notifications: [], phase: "idle", consumers: [], transitions: [] };
        }
    }
    async write(state: State): Promise<void> {
        await writeFile(join(this.root, "state.json"), JSON.stringify(state));
    }
}
