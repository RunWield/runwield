import { mkdtempSync as fsMkdtempSync, rmSync as fsRmSync } from "node:fs";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
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
    const projectRoot = fsMkdtempSync(join(tmpdir(), prefix));
    process.once("exit", () => {
        try {
            fsRmSync(projectRoot, { recursive: true });
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
        const previousHome = process.env["HOME"];
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-tool-metrics-"));
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);

        try {
            process.env["HOME"] = homeDir;
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            await run({
                homeDir,
                projectRoot,
                async readMetrics() {
                    await drainWorkflowMetrics();
                    try {
                        const contents = await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8");
                        return contents.trim().split("\n").map((line) => JSON.parse(line));
                    } catch (error) {
                        if (
                            error instanceof Error && "code" in error &&
                            (error.code === "ENOENT" || error.code === "ENOTDIR")
                        ) {
                            return [];
                        }
                        throw error;
                    }
                },
            });
        } finally {
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}
