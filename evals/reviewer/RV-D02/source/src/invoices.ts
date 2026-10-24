import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Invoice } from "./model.ts";

export async function loadInvoice(root: string, number: string): Promise<Invoice> {
    if (!/^[a-zA-Z0-9-]+$/.test(number)) throw new Error("Invalid invoice number");
    return JSON.parse(await readFile(join(root, `${number}.json`), "utf8"));
}
export function totalCents(invoice: Invoice): number {
    return invoice.items.reduce((total, item) => total + item.cents, 0);
}
