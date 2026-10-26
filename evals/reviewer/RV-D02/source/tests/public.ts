import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceipt } from "../src/receipts.ts";

async function withShop(settings: string, check: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "receipts-"));
    try {
        await writeFile(join(root, "receipt-settings.json"), settings);
        await writeFile(
            join(root, "inv-7.json"),
            JSON.stringify({
                number: "inv-7",
                items: [
                    { label: "Tea", cents: 350 },
                    { label: "Bread", cents: 225 },
                ],
            }),
        );
        await check(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
await withShop('{"shop":"Market"}', async (root) => {
    assert.equal(
        await createReceipt(root, "inv-7"),
        "Market\nReceipt inv-7\nTea: 3.50\nBread: 2.25\nTotal: 5.75\nJoin our rewards club for member offers.\n",
    );
});
console.log("PASS ordinary receipts include totals and the default offer");
await withShop("{}", async (root) => {
    await assert.rejects(createReceipt(root, "../private"), /Invalid invoice number/);
});
console.log("PASS invoice requests stay inside the shop");
