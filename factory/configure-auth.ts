/** Copy one explicitly selected provider into the personal Factory namespace. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonRecord } from "../src/shared/jsonc.ts";

const [provider = "openai", path = join(homedir(), ".wld", "auth.json")] = process.argv.slice(2);
const auth: JsonRecord = JSON.parse(await readFile(path, "utf8"));
const credential = auth[provider];
if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new Error(`No saved credential for provider ${provider}`);
}
const namespace = process.env.FACTORY_NAMESPACE || "runwield-personal";
const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "factory-model-auth", namespace },
    type: "Opaque",
    data: { "auth.json": Buffer.from(JSON.stringify({ [provider]: credential })).toString("base64") },
};
const child = Bun.spawn(["kubectl", "apply", "-f", "-"], {
    stdin: new Blob([JSON.stringify(manifest)]),
    stdout: "inherit",
    stderr: "inherit",
});
if (await child.exited) throw new Error("Factory credential provisioning failed");
