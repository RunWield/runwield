import { loadInvoice, totalCents } from "./invoices.ts";
import { loadSettings } from "./settings.ts";

export async function createReceipt(root: string, number: string): Promise<string> {
    const settings = await loadSettings(root);
    const invoice = await loadInvoice(root, number);
    const lines = [settings.shop, `Receipt ${invoice.number}`];
    for (const item of invoice.items) lines.push(`${item.label}: ${(item.cents / 100).toFixed(2)}`);
    lines.push(`Total: ${(totalCents(invoice) / 100).toFixed(2)}`);
    lines.push("Join our rewards club for member offers.");
    return lines.join("\n") + "\n";
}
