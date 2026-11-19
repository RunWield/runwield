import { equal, match, notEqual, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { RunWieldCredentialStore, RunWieldModelRegistry } from "./model-registry.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function registryFor(configDir: string): Promise<RunWieldModelRegistry> {
    registerBunOAuthFlows();
    const credentialStore = new RunWieldCredentialStore(join(configDir, "auth.json"));
    const runtime = await ModelRuntime.create({ credentials: credentialStore, modelsPath: null });
    return new RunWieldModelRegistry({ configDir, credentialStore, runtime });
}

/** Run the real OpenAI flow, but stop at the browser prompt before any account or token request. */
async function openAIHostId(registry: RunWieldModelRegistry): Promise<string> {
    let hostId = "";
    await rejects(
        registry.loginProvider("openai", "oauth", {
            notify(event) {
                if (event.type === "auth_url") {
                    hostId = new URL(event.url).searchParams.get("ext_agent_host_id") || "";
                }
            },
            prompt: () => Promise.reject(new Error("test stopped before account sign-in")),
        }),
        /test stopped before account sign-in/,
    );
    match(hostId, /^urn:uuid:/);
    const id = hostId.slice("urn:uuid:".length);
    match(id, UUID);
    return id;
}

test("OpenAI sign-in reaches the browser with one saved UUID across new runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-openai-login-"));
    const configDir = join(root, ".wld");
    try {
        const firstId = await openAIHostId(await registryFor(configDir));
        equal(await openAIHostId(await registryFor(configDir)), firstId);
        equal((await readFile(join(configDir, "device-id"), "utf8")).trim(), firstId);
        if (platform !== "win32") equal((await stat(join(configDir, "device-id"))).mode & 0o777, 0o600);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("separate installations use different OpenAI agent host IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-openai-installations-"));
    try {
        const firstId = await openAIHostId(await registryFor(join(root, "first")));
        const secondId = await openAIHostId(await registryFor(join(root, "second")));
        notEqual(firstId, secondId);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("an invalid saved device ID is reported without replacing the identity or credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-openai-invalid-id-"));
    try {
        const auth = '{"openai-codex":{"type":"oauth","access":"existing-token"}}';
        await writeFile(join(root, "auth.json"), auth);
        await writeFile(join(root, "device-id"), "invalid-id\n");
        const registry = await registryFor(root);
        await rejects(
            registry.loginProvider("openai", "oauth", {
                notify() {},
                prompt: () => Promise.reject(new Error("must not reach account sign-in")),
            }),
            /Invalid installation device ID/,
        );
        equal(await readFile(join(root, "device-id"), "utf8"), "invalid-id\n");
        equal(await readFile(join(root, "auth.json"), "utf8"), auth);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("an unreadable device ID stops sign-in without reporting browser authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-openai-unreadable-id-"));
    try {
        await mkdir(join(root, "device-id"));
        const registry = await registryFor(root);
        let notified = false;
        await rejects(
            registry.loginProvider("openai", "oauth", {
                notify() {
                    notified = true;
                },
                prompt: () => Promise.reject(new Error("must not reach account sign-in")),
            }),
            /EISDIR|EACCES/,
        );
        equal(notified, false);
        equal((await stat(join(root, "device-id"))).isDirectory(), true);
        equal(await registry.getStoredCredentialType("openai"), undefined);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("OpenAI API-key login does not create an installation device ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-openai-api-key-"));
    try {
        const registry = await registryFor(root);
        await registry.loginProvider("openai", "api_key", {
            notify() {},
            prompt: () => Promise.resolve("fixture-openai-key"),
        });
        equal(await registry.getStoredCredentialType("openai"), "api_key");
        await rejects(stat(join(root, "device-id")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true });
    }
});
