import { dirname, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openOwnerCoordinationStore } from "../../../shared/owner-coordination/index.js";
import { getWorkflowMetricsFilePath } from "../../../shared/workflow/metrics.js";
import { loadOwnerUsage } from "./owner-usage.ts";

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "runwield-usage-preview-"));
    const store = openOwnerCoordinationStore({ dbPath: join(root, "owner.sqlite3") });
    const projects = ["RunWield", "Notes", "Archived Project"];
    for (const [index, name] of projects.entries()) {
        const projectRoot = join(root, name);
        await Deno.mkdir(projectRoot);
        const project = store.registerProject({ root: projectRoot, displayName: name });
        if (index === 2) {
            store.setProjectEnabled(project.projectId, false);
            continue;
        }
        const path = getWorkflowMetricsFilePath(store.requireEnabledProjectRoot(project.projectId));
        await Deno.mkdir(dirname(path), { recursive: true });
        const now = Date.now();
        const rows = [{
            v: 1,
            event: "collection_epoch",
            enabled: true,
            ts: new Date(now - 31 * 86400000).toISOString(),
            eventId: crypto.randomUUID(),
        }];
        const observations = [];
        for (let day = 29; day >= 1; day--) {
            const ts = new Date(now - day * 86400000).toISOString();
            if (day === 12) observations.push({ v: 2, event: "measurement_gap", ts, eventId: crypto.randomUUID() });
            if (day % 4 !== 0) {
                observations.push({ v: 2, event: "command_started", ts, eventId: crypto.randomUUID() });
                observations.push({
                    v: 2,
                    event: "model_usage",
                    ts,
                    eventId: crypto.randomUUID(),
                    inputTokens: (30 - day) * 120 + index * 90,
                    outputTokens: 420,
                    cacheReadTokens: 100,
                    cacheWriteTokens: 0,
                    inputCacheBasis: "excludes_cache",
                    aggregationBasis: "turn",
                    costAmount: 0.02 * (30 - day),
                    costCurrency: "USD",
                    costSource: "calculated",
                    backend: index ? "claude-cli" : "pi",
                    provider: "preview",
                    model: index ? "sonnet" : "gpt",
                });
            }
        }
        await writeFile(
            path,
            [...rows, ...observations, {
                v: 1,
                event: "collection_epoch",
                enabled: true,
                ts: new Date(now).toISOString(),
                eventId: crypto.randomUUID(),
            }].map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
    }
    return store;
}

const fixture = createFixture();

/** Surface Lab uses real registered temporary Projects and Core aggregation, not precomputed totals. */
export async function devUsageReport(params: URLSearchParams) {
    return await loadOwnerUsage(await fixture, params);
}
