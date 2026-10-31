import { spawnNativeProcess } from "../foreground-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { parseRemoteInteractiveConfig } from "./entry.ts";

import process from "node:process";

async function privateEntry(args: string[], input?: string) {
    const child = spawnNativeProcess(process.execPath, {
        cwd: getCwd(),
        args: ["run", ...[], "src/cli.ts", ...args],
        stdin: input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
    });
    if (input !== undefined) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(input));
        await writer.close();
    }
    const [result, stdout, stderr] = await Promise.all([
        child.status,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return {
        code: result.code,
        stdout,
        stderr,
    };
}

test("remote preflight runs before ordinary CLI startup", async () => {
    const result = await privateEntry(["--remote-preflight"]);
    if (result.code === 0) {
        const identity = JSON.parse(result.stdout);
        assertEquals(typeof identity.buildId, "string");
        assertEquals(identity.buildId.length, 64);
        assertEquals(Number.isInteger(identity.protocol), true);
        assertEquals(typeof identity.version, "string");
    } else {
        // Source checkouts have no generated build identity and must not
        // present themselves as a deployable remote artifact.
        assertStringIncludes(result.stderr, "build-identity.js");
        assertEquals(result.stdout, "");
    }
    assertEquals(result.stderr.includes("Unknown option"), false);
});

test("remote view rejects malformed configuration before terminal or registry startup", async () => {
    const result = await privateEntry(["--remote-view"], "{}\n");
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "Invalid remote view host");
    assertEquals(result.stdout, "");
    assertEquals(result.stderr.includes("Unknown option"), false);
});

test("remote interactive entry refuses stale status-only configuration before opening a local Session", async () => {
    const config = {
        host: "remote-server",
        cwd: "/srv/project",
        status: "Connected",
        trust: "SSH verified",
        readiness: "Waiting",
    };
    const result = await privateEntry(["--remote-view"], `${JSON.stringify(config)}\nq`);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "Invalid remote interactive configuration");
    assertEquals(result.stdout, "");
});

test("remote view rejects an unfinished input header", async () => {
    const result = await privateEntry(["--remote-view"], '{"host":"server"}');
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "configuration is missing or incomplete");
});

test("remote bootstrap rejects invalid control identity, cwd, and mount roots", async () => {
    const config = {
        review: { socketPath: `/tmp/wld-remote-${"a".repeat(32)}/review.sock`, origin: "http://127.0.0.1:43127" },
        connection: { port: 1234, credential: "a".repeat(64) },
        cwd: "/remote/project",
        resources: { globalRoot: "/private/verified-mount" },
        memoryCollection: "project@host-1234",
        view: { host: "host", cwd: "/remote/project", status: "Connected", trust: "Trusted", readiness: "Ready" },
    };
    assertEquals(await parseRemoteInteractiveConfig(JSON.stringify(config)), config);
    for (const invalid of [
        { ...config, connection: { port: 0, credential: config.connection.credential } },
        { ...config, connection: { port: 65536, credential: config.connection.credential } },
        { ...config, connection: { port: 1234, credential: "not-a-credential" } },
        { ...config, memoryCollection: "" },
        { ...config, cwd: "relative" },
        { ...config, cwd: "/another/project" },
        { ...config, resources: { globalRoot: "relative-mount" } },
    ]) {
        await assertRejects(
            () => parseRemoteInteractiveConfig(JSON.stringify(invalid)),
            Error,
            "Invalid remote interactive configuration",
        );
    }
});

test("remote bootstrap rejects missing or unsafe review transport before TUI startup", async () => {
    const config = {
        connection: { port: 1234, credential: "a".repeat(64) },
        cwd: "/remote/project",
        resources: { globalRoot: "/private/verified-mount" },
        memoryCollection: "project@host-1234",
        view: { host: "host", cwd: "/remote/project", status: "Connected", trust: "Trusted", readiness: "Ready" },
    };
    const valid = { socketPath: `/tmp/wld-remote-${"a".repeat(32)}/review.sock`, origin: "http://127.0.0.1:43127" };
    for (const review of [
        undefined,
        null,
        { ...valid, socketPath: "/tmp/another-owner/review.sock" },
        { ...valid, socketPath: valid.socketPath + "\0" },
        { ...valid, origin: "https://example.com" },
        { ...valid, origin: "http://127.0.0.1:0" },
        { ...valid, origin: "http://127.0.0.1:65536" },
    ]) {
        await assertRejects(() => parseRemoteInteractiveConfig(JSON.stringify({ ...config, review })), Error);
    }
});
