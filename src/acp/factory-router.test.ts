import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { parseProjectId, projects, type ProjectId } from "@runwield/projects";
import { withRuntimeCommandFixture, type RuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import {
    executeFactoryRouter,
    FACTORY_EXECUTE_METHOD,
    parseFactoryRouterRequest,
    type FactoryRouterRequest,
    type FactoryRouterResponse,
} from "./factory-router.ts";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { startRunWieldAcpServer } from "./server.ts";

async function withFactoryProject(
    name: string,
    run: (fixture: RuntimeCommandFixture, input: FactoryRouterRequest) => Promise<void>,
) {
    await withRuntimeCommandFixture(name, async (fixture) => {
        const registry = projects.registrations.open();
        const previous = process.env.WLD_FACTORY_PROJECT_ID;
        try {
            const project = registry.register({ root: fixture.projectRoot });
            process.env.WLD_FACTORY_PROJECT_ID = project.projectId;
            await run(fixture, request(fixture.alternateRoot, project.projectId));
        } finally {
            registry.close();
            if (previous === undefined) delete process.env.WLD_FACTORY_PROJECT_ID;
            else process.env.WLD_FACTORY_PROJECT_ID = previous;
        }
    });
}

test("Factory Router is advertised and callable through the ACP SDK without creating a conversation", async () => {
    await withFactoryProject("factory-router-wire-", async (fixture, input) => {
        fixture.setModelMessages([
            fauxAssistantMessage(
                fauxToolCall("triage_report", {
                    routingIntent: "INQUIRY",
                    complexity: "LOW",
                    summary: "Explain the repository.",
                }),
            ),
        ]);
        const toAgent = new TransformStream<Uint8Array>();
        const toClient = new TransformStream<Uint8Array>();
        const server = startRunWieldAcpServer(toAgent.readable, toClient.writable);
        const connection = client({ name: "Factory Router test" }).connect(
            ndJsonStream(toAgent.writable, toClient.readable),
        );
        try {
            const initialized = await connection.agent.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
            });
            assert.deepEqual(initialized.agentCapabilities?._meta?.["dev.runwield/factory"], {
                version: 1,
                loops: ["router"],
            });
            const first = await connection.agent.request<FactoryRouterResponse>(FACTORY_EXECUTE_METHOD, input);
            assert.equal(first.result.routingIntent, "INQUIRY");
            assert.equal(first.projectId, input.projectId);
            assert.deepEqual(
                await connection.agent.request<FactoryRouterResponse>(FACTORY_EXECUTE_METHOD, input),
                first,
            );
            await assert.rejects(connection.agent.request(FACTORY_EXECUTE_METHOD, { ...input, version: 2 }));
            delete process.env.WLD_FACTORY_PROJECT_ID;
            assert.equal(
                (
                    await connection.agent.request("initialize", {
                        protocolVersion: PROTOCOL_VERSION,
                        clientCapabilities: {},
                    })
                ).agentCapabilities?._meta?.["dev.runwield/factory"],
                undefined,
            );
            await assert.rejects(
                connection.agent.request(FACTORY_EXECUTE_METHOD, input),
                /no configured canonical Project ID/,
            );
        } finally {
            connection.close();
            server.close();
            await Promise.all([connection.closed, server.closed]);
        }
    });
});

function request(cwd: string, projectId: ProjectId): FactoryRouterRequest {
    return {
        version: 1,
        operationId: "run:router",
        projectId,
        loop: "router",
        cwd,
        input: { prompt: "Fix the misspelled README title." },
    };
}

test("Factory Router validates protocol version, loop and required input", () => {
    const projectId = parseProjectId("430208b7-6292-43d6-9b19-77f22f384842");
    assert(projectId);
    const valid = request("/workspace", projectId);
    assert.deepEqual(parseFactoryRouterRequest(JSON.parse(JSON.stringify(valid))), valid);
    for (const invalid of [
        null,
        [],
        {},
        { ...valid, version: 2 },
        { ...valid, loop: "engineer" },
        { ...valid, cwd: "relative" },
        { ...valid, input: { prompt: " " } },
        { ...valid, projectId: 7 },
        { ...valid, projectId: "opaque-project" },
    ]) {
        assert.throws(() => parseFactoryRouterRequest(invalid));
    }
});

test("Factory Router concurrently replays one durable result without agent transition or repeated model calls", async () => {
    await withFactoryProject("factory-router-replay-", async (fixture, input) => {
        let calls = 0;
        fixture.setModelResponseFactory((context) => {
            calls++;
            const names = getCurrentTools(context.messages).map((tool) => tool.name);
            assert.deepEqual(names, ["triage_report"]);
            return fauxAssistantMessage(
                fauxToolCall("triage_report", {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Correct one README title.",
                }),
            );
        });
        const [first, concurrent] = await Promise.all([executeFactoryRouter(input), executeFactoryRouter(input)]);
        assert.deepEqual(first, concurrent);
        assert.equal(first.phase, "Completed");
        assert.equal(first.projectId, input.projectId);
        assert.equal(first.result.routingIntent, "QUICK_FIX");
        assert.equal(calls, 1);
        fixture.setModelResponseFactory(() => {
            throw new Error("A receipt replay must not call the model");
        });
        assert.deepEqual(await executeFactoryRouter(input), first);
        const key = createHash("sha256").update(input.operationId).digest("hex");
        const receipt = JSON.parse(await readFile(join(fixture.homeDir, ".wld", "factory", `${key}.json`), "utf8"));
        assert.deepEqual(receipt.response, first);
        await assert.rejects(
            executeFactoryRouter({ ...input, input: { prompt: "Different work" } }),
            /different inputs/,
        );
        const otherProjectId = parseProjectId(crypto.randomUUID());
        assert(otherProjectId);
        await assert.rejects(executeFactoryRouter({ ...input, projectId: otherProjectId }), /does not match/);
    });
});

test("Factory Router refuses missing or mismatched Project bindings and other cwd paths before admitting work", async () => {
    await withFactoryProject("factory-router-binding-", async (fixture, input) => {
        const otherProjectId = parseProjectId(crypto.randomUUID());
        assert(otherProjectId);
        await assert.rejects(executeFactoryRouter({ ...input, projectId: otherProjectId }), /does not match/);
        await assert.rejects(
            executeFactoryRouter({ ...input, cwd: fixture.projectRoot }),
            /cwd does not match the worker workspace/,
        );
        process.env.WLD_FACTORY_PROJECT_ID = "invalid-project";
        await assert.rejects(executeFactoryRouter(input), /no configured canonical Project ID/);
        await assert.rejects(stat(join(fixture.homeDir, ".wld", "factory")), { code: "ENOENT" });
    });
});

test("Factory Router retries an interrupted admitted operation and refuses prose as completion", async () => {
    await withFactoryProject("factory-router-retry-", async (fixture, input) => {
        fixture.setModelResponse("I would choose QUICK_FIX.");
        await assert.rejects(executeFactoryRouter(input), /exactly one triage_report/);
        const key = createHash("sha256").update(input.operationId).digest("hex");
        const path = join(fixture.homeDir, ".wld", "factory", `${key}.json`);
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { request: input });
        fixture.setModelMessages([
            fauxAssistantMessage(
                fauxToolCall("triage_report", {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Correct one README title.",
                }),
            ),
        ]);
        const completed = await executeFactoryRouter(input);
        assert.equal(completed.phase, "Completed");
        await writeFile(path, "invalid JSON");
        await assert.rejects(executeFactoryRouter(input), SyntaxError);
    });
});
