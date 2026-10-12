import { assert } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "./process-global-lock.ts";
import { __resetSettingsForTests, setCustomSetting } from "../shared/settings.js";
import { approveMetricsExporter, listInstalledMetricsExporters } from "../shared/extensions/metrics-exporter.ts";
import {
    grantMetricsExportDestination,
    type MetricsExportDestinationGrant,
} from "../shared/workflow/metrics-export-grants.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.js";
import { readMetricsExportLedger } from "../shared/workflow/metrics-export-ledger.ts";
import type { MetricsExportObservation } from "../shared/workflow/metrics-export-record.ts";

export const FIXTURE_EXPORTER = `
export async function deliver(o, c) {
  if (!Object.isFrozen(o) || !Object.isFrozen(o.fields)) throw new Error('observation must be immutable');
  const path = new URL(c.endpoint).pathname;
  if (path === '/exit') Deno.exit(23);
  if (path === '/throw') throw new Error('credential-secret-do-not-log');
  if (path === '/hang') await new Promise(() => {});
  if (path === '/malformed') return { outcome: 'magic', code: c.credentials.secretKey };
  const response = await fetch(c.endpoint, { method: 'POST', body: JSON.stringify(o), headers: { 'authorization': c.credentials.secretKey || '' } });
  await response.text();
  if (response.ok) return { outcome: 'accepted', code: path === '/unsafe-code' ? c.credentials.secretKey : 'http_200' };
  return { outcome: 'not_accepted', retry: response.status === 503 ? 'retryable' : response.status === 401 ? 'needs_correction' : 'permanent', code: 'http_' + response.status };
}
export async function confirm(o, c) {
  const response = await fetch(c.endpoint + '/confirm', { method: 'POST', body: JSON.stringify(o) });
  return { status: await response.text() };
}
`;
export interface MetricsExportFixture {
    home: string;
    project: string;
    packageRoot: string;
    requests: MetricsExportObservation[];
    confirmations: MetricsExportObservation[];
    headers: string[];
    endpoint(path?: string): string;
    grant(path?: string, projectRoots?: string[]): Promise<MetricsExportDestinationGrant>;
    record(event?: string, executionId?: string, project?: string): Promise<void>;
    hold(): void;
    release(): void;
    waitForRequest(): Promise<void>;
    holdConfirmation(): void;
    waitForConfirmation(): Promise<void>;
}
export async function withMetricsExportFixture(run: (fixture: MetricsExportFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "metrics-export-" }));
        const home = join(root, "home");
        const project = join(root, "project");
        const packageRoot = join(root, "package");
        for (const directory of [home, project, packageRoot]) await Deno.mkdir(directory);
        const oldHome = Deno.env.get("HOME");
        const oldSandbox = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        Deno.env.set("HOME", home);
        Deno.env.set("WLD_TEST_SANDBOX_HOME", home);
        __resetSettingsForTests();
        const requests: MetricsExportObservation[] = [];
        const confirmations: MetricsExportObservation[] = [];
        const headers: string[] = [];
        let held: Promise<void> | undefined;
        let confirmationHeld: Promise<void> | undefined;
        let releaseConfirmation = () => {};
        let confirmationArrived = () => {};
        const confirmedRequest = new Promise<void>((resolve) => {
            confirmationArrived = resolve;
        });
        let release = () => {};
        let requestArrived = () => {};
        const arrived = new Promise<void>((resolve) => {
            requestArrived = resolve;
        });
        const server = Deno.serve({
            hostname: "127.0.0.1",
            port: 0,
            onListen() {},
            onError: () => new Response(null, { status: 500 }),
        }, async (request) => {
            const path = new URL(request.url).pathname;
            const body: MetricsExportObservation = await request.json();
            if (path.endsWith("/confirm")) {
                confirmations.push(body);
                confirmationArrived();
                if (confirmationHeld) await confirmationHeld;
                return new Response(
                    path.startsWith("/present") || path.startsWith("/drop-present")
                        ? "present"
                        : path.startsWith("/mismatch")
                        ? "mismatch"
                        : "not_found_yet",
                );
            }
            // This is a durability acceptance check, not a replacement for Core's ledger.
            assert(
                [...readMetricsExportLedger("fixture").values()].some((item) => item.state === "sending"),
                "intent must exist before I/O",
            );
            requests.push(body);
            headers.push(request.headers.get("authorization") ?? "");
            requestArrived();
            if (held) await held;
            if (path.startsWith("/drop")) {
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("accepted"));
                            setTimeout(() => controller.error(new Error("response lost")), 20);
                        },
                    }),
                );
            }
            return new Response("ack", {
                status: path === "/503" ? 503 : path === "/401" ? 401 : path === "/400" ? 400 : 200,
            });
        });
        try {
            await Deno.writeTextFile(
                join(packageRoot, "package.json"),
                JSON.stringify({
                    name: "fixture-exporter",
                    version: "1.0.0",
                    wld: { metricsExporter: { contract: 1, id: "fixture", entry: "exporter.js" } },
                }),
            );
            await Deno.writeTextFile(join(packageRoot, "exporter.js"), FIXTURE_EXPORTER);
            await setCustomSetting("packages", [packageRoot], "global", project);
            await setCustomSetting("workflowMetrics", true, "project", project);
            await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
            let seq = 0;
            const endpoint = (path = "/accept") => `http://127.0.0.1:${server.addr.port}${path}`;
            await run({
                home,
                project,
                packageRoot,
                requests,
                confirmations,
                headers,
                endpoint,
                grant: (path = "/accept", projectRoots = [project]) =>
                    grantMetricsExportDestination({
                        destinationId: "fixture",
                        exporterId: "fixture",
                        exporterSource: packageRoot,
                        endpoint: endpoint(path),
                        externalProject: "vendor-project",
                        allowInsecureLocalEndpoint: true,
                        projectRoots,
                    }),
                async record(event = "model_usage", executionId, root = project) {
                    const result = await recordWorkflowMetric({
                        v: 2,
                        recorderId: "fixture",
                        seq: seq++,
                        eventId: crypto.randomUUID(),
                        event,
                        category: event.startsWith("execution_")
                            ? "execution"
                            : event === "tool_call_finished"
                            ? "tool_usage"
                            : "model_usage",
                        executionId,
                        sessionId: "raw-session-id",
                        planId: "raw-plan-id",
                        backend: "pi",
                        provider: "fixture",
                        model: "fixture-model",
                        inputTokens: 4,
                        outputTokens: 2,
                        costAmount: 0.1,
                        costCurrency: "USD",
                        costSource: "reported",
                        aggregationBasis: "turn",
                        outcome: "succeeded",
                        reason: "completed",
                        elapsedMs: 10,
                        toolName: "read",
                        durationMs: 5,
                    }, root);
                    assert(result.persisted, result.reason);
                },
                hold() {
                    held = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                },
                release() {
                    release();
                    releaseConfirmation();
                    held = undefined;
                    confirmationHeld = undefined;
                },
                holdConfirmation() {
                    confirmationHeld = new Promise<void>((resolve) => {
                        releaseConfirmation = resolve;
                    });
                },
                waitForConfirmation() {
                    return confirmedRequest;
                },
                waitForRequest() {
                    return arrived;
                },
            });
        } finally {
            release();
            releaseConfirmation();
            await server.shutdown();
            __resetSettingsForTests();
            if (oldHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", oldHome);
            if (oldSandbox === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", oldSandbox);
            await Deno.remove(root, { recursive: true });
        }
    });
}
