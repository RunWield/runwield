import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanArea, PlanRecord } from "./model.ts";
import { validateId } from "./model.ts";

export function planFile(root: string, area: PlanArea, id: string): string {
    validateId(id);
    return join(root, "plans", area, id + ".json");
}
export async function savePlan(root: string, area: PlanArea, record: PlanRecord): Promise<void> {
    const file = planFile(root, area, record.id);
    await mkdir(join(root, "plans", area), { recursive: true });
    await writeFile(file, JSON.stringify(record));
}
export async function readPlan(root: string, area: PlanArea, id: string): Promise<PlanRecord> {
    const record: PlanRecord = JSON.parse(await readFile(planFile(root, area, id), "utf8"));
    return record;
}
export async function listPlans(root: string): Promise<PlanRecord[]> {
    const records: PlanRecord[] = [];
    for (const area of ["active", "archived"] as const) {
        let names: string[];
        try {
            names = await readdir(join(root, "plans", area));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            throw error;
        }
        for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
            records.push(await readPlan(root, area, name.slice(0, -5)));
        }
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
}
