import { join } from "@std/path";
import { setCustomSetting } from "../shared/settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../shared/workflow/metrics.js";
import { withProcessGlobalTestLock } from "./process-global-lock.ts";

export type WorkflowMetricFixtureValue =
    | string
    | number
    | boolean
    | null
    | WorkflowMetricFixtureValue[]
    | { [key: string]: WorkflowMetricFixtureValue };

export interface WorkflowMetricFixtureRecord {
    v: 1 | 2;
    ts: string;
    category: string;
    event: string;
    agentName?: string;
    planName?: string;
    cwdHash: string;
    details?: { [key: string]: WorkflowMetricFixtureValue };
    [key: string]: unknown;
}

export interface WorkflowMetricsFixture {
    homeDir: string;
    projectRoot: string;
    readMetrics(): Promise<WorkflowMetricFixtureRecord[]>;
}

export function makeToolProjectFixture(prefix: string): string {
    const projectRoot = Deno.makeTempDirSync({ prefix });
    globalThis.addEventListener("unload", () => {
        try {
            Deno.removeSync(projectRoot, { recursive: true });
        } catch {
            // The fixture may already have been removed during an interrupted test.
        }
    });
    return projectRoot;
}

export async function withWorkflowMetricsFixture(
    run: (fixture: WorkflowMetricsFixture) => Promise<void>,
): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-tool-metrics-" });
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);

        try {
            Deno.env.set("HOME", homeDir);
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            await run({
                homeDir,
                projectRoot,
                async readMetrics() {
                    await drainWorkflowMetrics();
                    try {
                        const contents = await Deno.readTextFile(getWorkflowMetricsFilePath(projectRoot));
                        return contents.trim().split("\n").map((line) => JSON.parse(line));
                    } catch (error) {
                        if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory) {
                            return [];
                        }
                        throw error;
                    }
                },
            });
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await Deno.remove(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}
