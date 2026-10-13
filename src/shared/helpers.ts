import { stat } from "node:fs/promises";

export async function directoryExists(path: string): Promise<boolean> {
    try {
        const info = await stat(path);
        return info.isDirectory();
    } catch {
        return false;
    }
}

export async function fileExists(path: string): Promise<boolean> {
    try {
        const info = await stat(path);
        return info.isFile();
    } catch {
        return false;
    }
}
