import { DefaultPackageManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { runInstallCommand } from "../../src/cmd/install/index.ts";
import {
    listInstalledMetricsExporters,
    readMetricsExporterDeclaration,
    resolveApprovedMetricsExporters,
} from "../../src/shared/extensions/metrics-exporter.ts";
import { resolveInstalledWldExtensionResources } from "../../src/shared/extensions/wld-extension-manifest.js";
import {
    __resetSettingsForTests,
    getSettingsDir,
    getSettingsManager,
    setCustomSetting,
} from "../../src/shared/settings.js";
import {
    grantMetricsExportDestination,
    setMetricsExportCredentials,
} from "../../src/shared/workflow/metrics-export-grants.ts";
import { readMetricsExportLedger } from "../../src/shared/workflow/metrics-export-ledger.ts";
import { readMetricsExportStatus, runMetricsExportCycle } from "../../src/shared/workflow/metrics-export-scheduler.ts";
import { recordWorkflowMetric } from "../../src/shared/workflow/metrics.js";
import { withProcessGlobalTestLock } from "../../src/testing/process-global-lock.ts";
import { initRunWieldTheme } from "../../src/ui/theme/theme.js";
import { type JsonRecord, observation, readback, span, withServer } from "./test-fixture.ts";

interface Manifest {
    files: string[];
    wld: { metricsExporter: { contract: number; id: string; entry: string } };
}
async function copyProduction(path: string): Promise<void> {
    await Deno.mkdir(path);
    const manifest: Manifest = JSON.parse(
        await Deno.readTextFile(new URL("./package.json", import.meta.url)),
    );
    assertEquals(manifest.files, ["exporter.ts", "README.md", "LICENSE"]);
    for (const file of ["package.json", ...manifest.files]) {
        await Deno.copyFile(new URL(file, import.meta.url), join(path, file));
    }
    assertEquals(
        (await Array.fromAsync(Deno.readDir(path))).map((entry) => entry.name)
            .sort(),
        ["LICENSE", "README.md", "exporter.ts", "package.json"],
    );
}
Deno.test("production-only copy loads and sends without repository configuration or dependencies", async () => {
    const root = await Deno.makeTempDir();
    try {
        const packageRoot = join(root, "package");
        await copyProduction(packageRoot);
        await withServer(async ({ context, requests }) => {
            const script = join(root, "check.ts");
            await Deno.writeTextFile(
                script,
                `import {deliver, confirm} from ${
                    JSON.stringify(toFileUrl(join(packageRoot, "exporter.ts")).href)
                };\nconsole.log(JSON.stringify(await deliver(${JSON.stringify(observation())}, ${
                    JSON.stringify(context)
                })));\nconsole.log(typeof confirm);\n`,
            );
            const result = await new Deno.Command(Deno.execPath(), {
                args: [
                    "run",
                    "--no-config",
                    "--no-npm",
                    "--allow-net=127.0.0.1",
                    script,
                ],
                cwd: root,
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            assertEquals(
                new TextDecoder().decode(result.stdout).trim(),
                '{"outcome":"accepted","code":"otlp_success"}\nfunction',
            );
            assertEquals(requests.length, 1);
        });
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
Deno.test("real absolute-directory install, owner approval, grant, journal, and worker delivery confirm without Pi loading", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await Deno.realPath(await Deno.makeTempDir());
        const home = join(root, "home"),
            project = join(root, "project"),
            source = join(root, "package");
        await Deno.mkdir(home);
        await Deno.mkdir(project);
        await copyProduction(source);
        const oldHome = Deno.env.get("HOME"),
            oldSandbox = Deno.env.get("WLD_TEST_SANDBOX_HOME"),
            oldCwd = Deno.cwd(),
            oldPrompt = globalThis.prompt,
            oldExit = Deno.exitCode;
        const rows = new Map<string, JsonRecord>();
        let proxyFailure = false, visible = true;
        try {
            Deno.env.set("HOME", home);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", home);
            Deno.chdir(project);
            Deno.exitCode = 0;
            __resetSettingsForTests();
            initRunWieldTheme();
            await withServer(async ({ context, requests }) => {
                assertEquals(await readMetricsExporterDeclaration(source), {
                    contract: 1,
                    id: "langfuse",
                    entry: "./exporter.ts",
                });
                globalThis.prompt = () => "n";
                await runInstallCommand([source]);
                assertEquals(Deno.exitCode, 0);
                const settings = getSettingsManager();
                const manager = new DefaultPackageManager({
                    cwd: project,
                    agentDir: getSettingsDir("global"),
                    settingsManager: settings,
                });
                assertEquals(manager.getInstalledPath(source, "user"), source);
                assertEquals(
                    manager.listConfiguredPackages().map((p) => p.installedPath),
                    [source],
                );
                assertEquals(
                    (await listInstalledMetricsExporters()).map((e) => e.approved),
                    [false],
                );
                assertEquals(await resolveApprovedMetricsExporters(), []);
                const grantInput = {
                    destinationId: "langfuse",
                    exporterId: "langfuse",
                    exporterSource: source,
                    endpoint: context.endpoint,
                    externalProject: context.externalProject,
                    allowInsecureLocalEndpoint: true,
                    projectRoots: [project],
                };
                await assertRejects(
                    () => grantMetricsExportDestination(grantInput),
                    Error,
                    "not installed and approved",
                );
                await runMetricsExportCycle();
                assertEquals(requests.length, 0);
                globalThis.prompt = (question = "") => {
                    assert(question.startsWith("Approve metrics exporter langfuse"));
                    return "yes";
                };
                await runInstallCommand([source]);
                assertEquals(Deno.exitCode, 0);
                __resetSettingsForTests();
                const approved = await resolveApprovedMetricsExporters();
                assertEquals(approved.length, 1);
                assertEquals(approved[0].entryPath, join(source, "exporter.ts"));
                assertEquals(await resolveInstalledWldExtensionResources(), []);
                const loader = new DefaultResourceLoader({
                    cwd: project,
                    agentDir: getSettingsDir("global"),
                    settingsManager: getSettingsManager(),
                    noExtensions: true,
                    noSkills: true,
                    noContextFiles: true,
                    noPromptTemplates: true,
                    additionalExtensionPaths: [],
                });
                await loader.reload();
                assertEquals(loader.getExtensions().extensions, []);
                assertEquals(loader.getExtensions().errors, []);
                await setCustomSetting("workflowMetrics", true, "project", project);
                let seq = 0;
                const record = async (partial = false) => {
                    const recorded = await recordWorkflowMetric({
                        v: 2,
                        recorderId: "langfuse-test",
                        seq: seq++,
                        eventId: crypto.randomUUID(),
                        event: "model_usage",
                        category: "model_usage",
                        sessionId: "local-session",
                        executionId: "local-execution",
                        backend: partial ? "agy-cli" : "pi",
                        provider: "google",
                        model: "gemini-3.8-flash",
                        usageKind: partial ? "turn" : "request",
                        aggregationBasis: partial ? "turn" : "request",
                        inputCacheBasis: "excludes_cache",
                        measurementAvailability: partial ? "partial" : "complete",
                        inputTokens: 100,
                        outputTokens: 20,
                        reasoningTokens: 12,
                        cacheReadTokens: 30,
                        cacheWriteTokens: partial ? null : 0,
                        costAmount: 0.01,
                        costCurrency: "USD",
                        costSource: "calculated",
                        startedAt: "2026-09-20T12:00:00.100Z",
                        endedAt: "2026-09-20T12:00:02.200Z",
                    }, project);
                    assert(recorded.persisted, recorded.reason);
                };
                await record(); // Before consent: must never be exported.
                assertEquals(await resolveApprovedMetricsExporters(), approved);
                grantInput.exporterSource = approved[0].source; // The installer normalizes local source identity.
                const grant = await grantMetricsExportDestination(grantInput);
                assert(grant.projects[0].offset > 0);
                await setMetricsExportCredentials("langfuse", context.credentials);
                await record();
                await runMetricsExportCycle({ deadlineMs: 5000 });
                assertEquals((await readMetricsExportStatus())[0].counts.confirmed, 1);
                assertEquals(requests.filter((r) => r.method === "POST").length, 1);
                const first = span(requests.find((r) => r.method === "POST")!);
                assert(!JSON.stringify(first).includes(project));
                assert(!JSON.stringify(first).includes("local-session"));
                assert(!JSON.stringify(first).includes("local-execution"));
                assertEquals(
                    requests[0].headers.get("authorization"),
                    `Basic ${btoa("pk-fixture:sk-fixture")}`,
                );
                proxyFailure = true;
                visible = false;
                await record(true);
                await runMetricsExportCycle({ deadlineMs: 5000 });
                assertEquals(
                    (await readMetricsExportStatus())[0].counts.unconfirmed,
                    1,
                );
                assertEquals(requests.filter((r) => r.method === "POST").length, 2);
                visible = true;
                await runMetricsExportCycle({ deadlineMs: 5000 });
                assertEquals((await readMetricsExportStatus())[0].counts.confirmed, 2);
                await runMetricsExportCycle({ deadlineMs: 5000 });
                assertEquals(requests.filter((r) => r.method === "POST").length, 2);
                assertEquals(
                    [...readMetricsExportLedger("langfuse").values()].map((item) => item.state),
                    ["confirmed", "confirmed"],
                );
            }, (wire) => {
                if (wire.method === "POST") {
                    assert(
                        [...readMetricsExportLedger("langfuse").values()].some((item) => item.state === "sending"),
                    );
                    const s = span(wire);
                    rows.set(s.spanId, readback(s));
                    return proxyFailure
                        ? new Response("upstream may already have accepted", {
                            status: 503,
                        })
                        : Response.json({});
                }
                const filters: IdFilter[] = JSON.parse(
                    wire.url.searchParams.get("filter")!,
                );
                const row = rows.get(filters[0].value);
                return Response.json({ data: visible && row ? [row] : [], meta: {} });
            });
        } finally {
            globalThis.prompt = oldPrompt;
            initRunWieldTheme();
            __resetSettingsForTests();
            Deno.chdir(oldCwd);
            if (oldHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", oldHome);
            if (oldSandbox === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", oldSandbox);
            Deno.exitCode = oldExit;
            await Deno.remove(root, { recursive: true });
        }
    });
});
interface IdFilter {
    value: string;
}
