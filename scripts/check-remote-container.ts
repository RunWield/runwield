/** Qualify the test-only remote image using disposable containers and a private volume. */
import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { randomUUID } from "node:crypto";
import { generateBearerCapability, hashCapability } from "../src/shared/collaboration/capabilities.ts";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { captureScriptProcess } from "./script-process.ts";
import { assertPlanServerImageFileList, listImageFilesystem } from "./assert-plan-server-image.ts";

const engine = process.argv[2] || "docker";
const image = process.argv[3] || "runwield-plan-server:local";
if (!["docker", "podman"].includes(engine)) throw new Error("Use docker or podman as the container engine.");
const name = `runwield-remote-check-${randomUUID()}`;
const volume = `${name}-data`;

async function run(...args: string[]): Promise<string> {
    const result = await captureScriptProcess(engine, { args, signal: AbortSignal.timeout(60_000) });
    const stdout = new TextDecoder().decode(result.stdout);
    strictEqual(result.code, 0, `${engine} ${args[0]}: ${new TextDecoder().decode(result.stderr)}${stdout}`);
    return stdout.trim();
}

async function publishedBase(): Promise<string> {
    const address = (await run("port", name, "8080/tcp")).split("\n")[0];
    ok(/^127\.0\.0\.1:\d+$/.test(address), `Unexpected published address: ${address}`);
    return `http://${address}`;
}

async function ready(base: string): Promise<void> {
    let detail = "no response";
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) });
            strictEqual(response.status, 200);
            deepStrictEqual(await response.json(), { ok: true, mode: "remote" });
            return;
        } catch (error) {
            detail = String(error);
            await delay(200);
        }
    }
    throw new Error(`Remote container never became ready at ${base}: ${detail}`);
}

try {
    const listing = await listImageFilesystem(image, engine);
    deepStrictEqual(assertPlanServerImageFileList(listing.files, listing.directories), {
        missingRequired: [],
        missingRequiredDirectories: [],
        prohibited: [],
    });
    await run("volume", "create", volume);
    await run(
        "run",
        "--detach",
        "--name",
        name,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        `type=volume,source=${volume},target=/data`,
        "--publish",
        "127.0.0.1::8080",
        image,
    );
    await run(
        "exec",
        name,
        "/bin/sh",
        "-ec",
        'test "$(id -u)" = 1993; test "$(bun --version)" = 1.4.3; if command -v deno; then exit 1; fi',
    );
    let base = await publishedBase();
    await ready(base);
    const health = await fetch(`${base}/healthz`);
    strictEqual(health.status, 200);
    deepStrictEqual(await health.json(), { ok: true, mode: "remote" });
    const review = await fetch(`${base}/p/container-smoke`);
    strictEqual(review.status, 200);
    const html = await review.text();
    ok(html.includes("Remote Plan Review"));
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_astro\/[^"#?]+)"/g)].map((match) => match[1]))];
    ok(
        assets.some((asset) => asset.endsWith(".css")),
        "Review page must reference its built stylesheet",
    );
    for (const asset of assets) {
        const response = await fetch(`${base}${asset}`);
        strictEqual(response.status, 200, asset);
        ok((await response.arrayBuffer()).byteLength > 0, asset);
        if (asset.endsWith(".css")) ok(response.headers.get("content-type")?.includes("text/css"));
    }
    await run(
        "exec",
        name,
        "bun",
        "-e",
        `
        import { writeFileSync } from "node:fs";
        let denied = false;
        try { writeFileSync("/app/should-not-write", "no"); } catch { denied = true; }
        if (!denied) throw new Error("Application directory is writable");
    `,
    );
    const reviewer = generateBearerCapability();
    const maintainer = generateBearerCapability();
    const payloadCiphertext = "cipher:container-persisted";
    const created = await fetch(`${base}/api/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            planId: `container-${randomUUID()}`,
            initialRevision: { payloadCiphertext },
            capabilities: [
                { scope: "reviewer", capabilityHash: await hashCapability(reviewer) },
                { scope: "maintainer", capabilityHash: await hashCapability(maintainer) },
            ],
        }),
    });
    strictEqual(created.status, 201, await created.clone().text());
    const space = await created.json();
    const assertRevision = async (): Promise<void> => {
        const response = await fetch(`${base}/api/spaces/${space.spaceId}/revisions/1`, {
            headers: { Authorization: `Bearer ${reviewer}` },
        });
        strictEqual(response.status, 200);
        strictEqual((await response.json()).revision.payloadCiphertext, payloadCiphertext);
    };
    await assertRevision();
    await run("stop", "--time", "10", name);
    strictEqual(await run("inspect", "--format", "{{.State.ExitCode}}", name), "0", "Shutdown must be graceful");
    await run("start", name);
    // Engines may assign a different ephemeral host port when a stopped container restarts.
    base = await publishedBase();
    await ready(base);
    await assertRevision();
    console.log(
        "Bun remote test image passed: runtime files, nonroot, no Deno, health/readiness, HTML/CSS, read-only app, SQLite persistence, graceful shutdown.",
    );
} catch (error) {
    const logs = await captureScriptProcess(engine, { args: ["logs", name], signal: AbortSignal.timeout(10_000) });
    console.error(new TextDecoder().decode(logs.stdout), new TextDecoder().decode(logs.stderr));
    throw error;
} finally {
    // Remove only resources created under this run's unique names.
    await captureScriptProcess(engine, { args: ["rm", "--force", name], signal: AbortSignal.timeout(15_000) });
    await captureScriptProcess(engine, { args: ["volume", "rm", volume], signal: AbortSignal.timeout(15_000) });
}
