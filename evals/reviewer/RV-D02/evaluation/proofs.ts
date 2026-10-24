import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceipt } from "../src/receipts.ts";
import { loadSettings } from "../src/settings.ts";

if (process.argv[2] !== "disabled-offers") throw new Error("Select disabled-offers");
const root = await mkdtemp(join(tmpdir(), "receipt-proof-"));
try {
    await writeFile(join(root, "receipt-settings.json"), '{"shop":"Quiet Shop","enabled":false}');
    await writeFile(
        join(root, "inv-1.json"),
        JSON.stringify({ number: "inv-1", items: [{ label: "Tea", cents: 350 }] }),
    );
    const receipt = await createReceipt(root, "inv-1");
    assert.equal(receipt, "Quiet Shop\nReceipt inv-1\nTea: 3.50\nTotal: 3.50\n", "RV-D02-FALSE-SETTING");
    assert.equal((await loadSettings(root)).enabled, false, "RV-D02-FALSE-SETTING");
    console.log("PASS disabled-offers");
} finally {
    await rm(root, { recursive: true, force: true });
}
