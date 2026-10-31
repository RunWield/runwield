import { readPlan } from "./plans.ts";

export async function planStatus(path: string): Promise<string> {
    const plan = await readPlan(path);
    return /^status: (.*)$/m.exec(plan.frontMatter)![1];
}
