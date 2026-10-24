import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanRef, PlanDocument } from "./model.ts";

export class PlanRepository {
    constructor(private readonly directory: string) {}
    private file(ref: PlanRef) {
        const identity = JSON.stringify([ref.projectId, ref.ownerId, ref.planId]);
        return join(this.directory, createHash("sha256").update(identity).digest("hex") + ".json");
    }
    async save(ref: PlanRef, document: PlanDocument): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        await writeFile(this.file(ref), JSON.stringify(document));
    }
    async read(ref: PlanRef): Promise<PlanDocument> {
        const document: PlanDocument = JSON.parse(await readFile(this.file(ref), "utf8"));
        return document;
    }
}
