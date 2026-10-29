import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReceiptSettings } from "./model.ts";

interface SavedSettings {
    shop?: string;
}
export async function loadSettings(root: string): Promise<ReceiptSettings> {
    const saved: SavedSettings = JSON.parse(await readFile(join(root, "receipt-settings.json"), "utf8"));
    return { shop: saved.shop ?? "Corner Shop" };
}
