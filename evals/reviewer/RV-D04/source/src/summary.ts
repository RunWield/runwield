import type { PlanDocument, PlanSummary } from "./model.ts";

export function summarize(document: PlanDocument): PlanSummary {
    const body = document.body
        .replace(/[#*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return { title: document.title, excerpt: body.slice(0, 100), words: body ? body.split(" ").length : 0 };
}
