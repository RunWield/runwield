/** Interrupt canonical import publication at the OS boundary and resume in a new process. */
import fs from "node:fs/promises";
import { mock } from "bun:test";
import type { ProjectIdentity } from "../../project-identity.ts";
const request: { identity: ProjectIdentity; path: string; interrupt?: boolean; readyPath?: string } = JSON.parse(
    process.argv[2],
);
const link = fs.link;
mock.module("node:fs/promises", () => ({
    ...fs,
    default: fs,
    async link(from: string, to: string) {
        await link(from, to);
        if (request.interrupt && to.endsWith(".md")) process.exit(86);
    },
}));
const { withWorkRecordOwner } = await import("../owner.ts");
const { importWorkRecords } = await import("../import.ts");
const { createWorkRecordMnemotecaFixture } = await import("./mnemoteca-port.ts");
await withWorkRecordOwner(request.identity.checkoutRoot, request.identity, async () => {
    if (request.readyPath) await fs.writeFile(request.readyPath, "ready");
    const result = await importWorkRecords(request.identity.checkoutRoot, request.path, {
        mnemotecaPort: createWorkRecordMnemotecaFixture(),
    });
    console.log(JSON.stringify(result.map((item) => item.record.attrs.recordId)));
});
