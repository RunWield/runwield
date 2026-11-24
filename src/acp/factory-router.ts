import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseProjectId, type ProjectId } from "@runwield/projects";
import { toolRegistry, type TriageOutcome } from "@runwield/tools";
import { getCwd, getHomeDir } from "../constants.ts";
import type { JsonRecord, JsonValue } from "../shared/jsonc.ts";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import {
    applySessionTemperature,
    assembleFinalSystemPrompt,
    getConfiguredAgentTemperature,
    resolveModel,
} from "../shared/session/session.ts";
import { agentRegistry } from "../shared/session/agent-registry.ts";
import { getModelRegistry, getModelRuntime } from "../shared/models/model-registry.ts";
import { assertModelExecutionBackendSupported } from "../shared/models/model-execution.ts";
import { getSettingsDir, getSettingsManager } from "../shared/settings.ts";
import { createTriageReportTool } from "../tools/triage-report.ts";
import {
    parseFactoryGitHubCommentReceipt,
    parseFactoryGitHubPublication,
    publishFactoryGitHubComment,
    type FactoryGitHubPublication,
    type FactoryGitHubCommentReceipt,
} from "./factory-github-publication.ts";
export type { FactoryGitHubPublication, FactoryGitHubCommentReceipt } from "./factory-github-publication.ts";

export const FACTORY_EXECUTE_METHOD = "_dev.runwield/factory/execute";
const triageReport = toolRegistry.get("triage_report");

export function configuredFactoryProjectId(): ProjectId | undefined {
    return parseProjectId(process.env.WLD_FACTORY_PROJECT_ID);
}

export interface FactoryRouterRequest {
    version: 1;
    operationId: string;
    projectId: ProjectId;
    loop: "router";
    cwd: string;
    input: { prompt: string };
    model?: string;
    publication?: FactoryGitHubPublication;
}

export interface FactoryRouterResponse {
    version: 1;
    operationId: string;
    projectId: ProjectId;
    loop: "router";
    phase: "Completed";
    result: TriageOutcome;
    publication?: FactoryGitHubCommentReceipt;
}

interface FactoryRouterReceipt {
    request: FactoryRouterRequest;
    result?: TriageOutcome;
    response?: FactoryRouterResponse;
}

function record(value: JsonValue | undefined): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new RequestError(-32602, "Factory request requires a JSON record");
    }
    return value;
}

function textField(value: JsonValue | undefined, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw new RequestError(-32602, `Invalid factory ${name}`);
    return value;
}

export function parseFactoryRouterRequest(value: JsonValue): FactoryRouterRequest {
    const request = record(value);
    if (request.version !== 1 || request.loop !== "router") {
        throw new RequestError(-32602, "Factory supports version 1 and loop router");
    }
    const cwd = textField(request.cwd, "cwd");
    if (!isAbsolute(cwd)) throw new RequestError(-32602, "Factory cwd must be absolute");
    const projectId = parseProjectId(textField(request.projectId, "projectId"));
    if (!projectId) throw new RequestError(-32602, "Invalid Factory Project ID");
    return {
        version: 1,
        operationId: textField(request.operationId, "operationId"),
        projectId,
        loop: "router",
        cwd,
        input: { prompt: textField(record(request.input).prompt, "input.prompt") },
        ...(request.model === undefined ? {} : { model: textField(request.model, "model") }),
        ...(request.publication === undefined
            ? {}
            : { publication: parseFactoryGitHubPublication(request.publication) }),
    };
}

function savedOutcome(value: JsonValue | undefined): TriageOutcome {
    const result = record(value);
    const outcome = triageReport.normalizeOutcome({
        routingIntent: textField(result.routingIntent, "receipt routingIntent"),
        complexity: textField(result.complexity, "receipt complexity"),
        summary: textField(result.summary, "receipt summary"),
        ...(result.workKind === undefined ? {} : { workKind: textField(result.workKind, "receipt workKind") }),
        ...(result.sessionName === undefined
            ? {}
            : { sessionName: textField(result.sessionName, "receipt sessionName") }),
    });
    if (!outcome) throw new Error("Invalid saved Factory Router result");
    return outcome;
}

async function persistReceipt(path: string, receipt: FactoryRouterReceipt): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(receipt));
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directory = await open(join(path, ".."), "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } finally {
        await unlink(temporary).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
}

/** One input-only Router turn. No HostedSession means no automatic workflow handoff. */
async function runRouter(request: FactoryRouterRequest): Promise<TriageOutcome> {
    const report = createTriageReportTool();
    const outcomes: TriageOutcome[] = [];
    const customTools = [
        {
            ...report,
            async execute(...args: Parameters<typeof report.execute>) {
                const result = await report.execute(...args);
                outcomes.push(result.details);
                return result;
            },
        },
    ];
    const tools = [triageReport.definition.name];
    const agentId = agentRegistry.ids.primary.ROUTER;
    const agentDef = await agentRegistry.get(agentId);
    const modelRuntime = await getModelRuntime();
    const model = await resolveModel(request.model, agentDef, agentId, getModelRegistry(), undefined, request.cwd);
    assertModelExecutionBackendSupported(model, true);
    const systemPrompt = await assembleFinalSystemPrompt(
        {
            ...agentDef,
            systemPrompt: agentDef.systemPrompt
                .replaceAll("{{MEMORIES}}", "")
                .replaceAll("{{SKILLS}}", "")
                .replaceAll("{{PROJECT_AGENTSMD}}", "")
                .replaceAll("{{PROJECT_STATE_CONTEXT}}", ""),
        },
        tools,
        customTools,
        request.cwd,
        "",
    );
    const settingsManager = getSettingsManager(request.cwd);
    const agentDir = getSettingsDir("global");
    const resourceLoader = new DefaultResourceLoader({
        cwd: request.cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
        systemPromptOverride: () =>
            `${systemPrompt}\n\nThis Factory Router operation has supplied input only. Its cwd is a private runtime directory, not a repository checkout. Do not claim repository discovery or inspection. Classify the supplied input and state material uncertainty in the triage_report summary when needed.`,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        cwd: request.cwd,
        agentDir,
        modelRuntime,
        model,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(request.cwd),
        noTools: "builtin",
        tools,
        customTools,
    });
    applySessionTemperature(session, getConfiguredAgentTemperature(agentId, request.cwd) ?? agentDef.temperature);
    try {
        await session.prompt(request.input.prompt);
        await session.agent.waitForIdle();
        if (outcomes.length !== 1) throw new Error("Factory Router must produce exactly one triage_report");
        return outcomes[0];
    } finally {
        session.dispose();
    }
}

/** Receipt replay survives worker replacement; interrupted reasoning is rerun, not checkpoint-resumed. */
export async function executeFactoryRouter(input: FactoryRouterRequest): Promise<FactoryRouterResponse> {
    const projectId = configuredFactoryProjectId();
    if (!projectId) throw new RequestError(-32602, "Factory worker has no configured canonical Project ID");
    if (input.projectId !== projectId) {
        throw new RequestError(-32602, "Factory Project ID does not match the worker binding");
    }
    const cwd = getCwd();
    if (input.cwd !== cwd) throw new RequestError(-32602, "Factory cwd does not match the worker workspace");
    const request = { ...input, projectId, cwd };
    const directory = join(getHomeDir(), ".wld", "factory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(request.operationId).digest("hex");
    const path = join(directory, `${key}.json`);
    const lock = openNativeFileLock(`${path}.lock`);
    try {
        await lock.lock(true);
        let saved: JsonRecord | undefined;
        try {
            saved = record(JSON.parse(await readFile(path, "utf8")));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (saved) {
            const admitted = parseFactoryRouterRequest(saved.request);
            if (JSON.stringify(admitted) !== JSON.stringify(request)) {
                throw new RequestError(-32602, "Factory operationId was already used with different inputs");
            }
            if (saved.response !== undefined) {
                const response = record(saved.response);
                const outcome = savedOutcome(response.result);
                if (
                    response.phase !== "Completed" ||
                    response.operationId !== request.operationId ||
                    response.projectId !== request.projectId ||
                    response.version !== 1 ||
                    response.loop !== "router"
                ) {
                    throw new Error("Invalid saved Factory Router receipt");
                }
                if (Boolean(request.publication) !== (response.publication !== undefined)) {
                    throw new Error("Invalid saved Factory publication receipt");
                }
                return {
                    version: 1,
                    operationId: request.operationId,
                    projectId: request.projectId,
                    loop: "router",
                    phase: "Completed",
                    result: outcome,
                    ...(response.publication === undefined
                        ? {}
                        : {
                              publication: parseFactoryGitHubCommentReceipt(response.publication),
                          }),
                };
            }
        } else {
            await persistReceipt(path, { request });
        }
        const result = saved?.result === undefined ? await runRouter(request) : savedOutcome(saved.result);
        // Routing is its own durable business transition: publication retries never rerun the model.
        await persistReceipt(path, { request, result });
        const publication = request.publication
            ? await publishFactoryGitHubComment(request.operationId, request.publication, result)
            : undefined;
        const response: FactoryRouterResponse = {
            version: 1,
            operationId: request.operationId,
            projectId: request.projectId,
            loop: "router",
            phase: "Completed",
            result,
            ...(publication ? { publication } : {}),
        };
        await persistReceipt(path, { request, result, response });
        return response;
    } finally {
        lock.close();
    }
}
