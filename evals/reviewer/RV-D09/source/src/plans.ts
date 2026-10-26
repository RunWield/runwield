import { readFile, writeFile } from "node:fs/promises";

export interface Plan {
    frontMatter: string;
    body: string;
}
export function parsePlan(text: string): Plan {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match || !/^status: (approved|validating)$/m.test(match[1])) throw new Error("Invalid Plan");
    return { frontMatter: match[1], body: match[2] };
}
export async function readPlan(path: string): Promise<Plan> {
    return parsePlan(await readFile(path, "utf8"));
}
export async function writePlan(path: string, plan: Plan): Promise<void> {
    await writeFile(path, `---\n${plan.frontMatter}\n---\n${plan.body}`);
}
export function withStatus(plan: Plan, status: "approved" | "validating"): Plan {
    return { ...plan, frontMatter: plan.frontMatter.replace(/^status: .*$/m, `status: ${status}`) };
}
