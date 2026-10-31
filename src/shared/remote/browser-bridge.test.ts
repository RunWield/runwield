import { test, mock } from "node:test";
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { BUILD_ID, REMOTE_PROTOCOL_VERSION } from "../build-identity.js";
import { startRemoteControlService } from "./control.ts";
import { createRemoteBrowserPort, handleBrowserOpen } from "./browser-bridge.ts";

const identity = { buildId: BUILD_ID, protocol: REMOTE_PROTOCOL_VERSION };
const origin = "http://127.0.0.1:43127";

async function withLaptopBrowser(run: (opened: () => Promise<string[]>) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const root = await mkdtemp(join(tmpdir(), "browser-bridge-"));
        const log = join(root, "opened");
        const previousPath = process.env.PATH;
        const previousSandbox = process.env.WLD_TEST_SANDBOX_HOME;
        try {
            for (const command of ["open", "xdg-open"]) {
                const path = join(root, command);
                await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`);
                await chmod(path, 0o700);
            }
            process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
            // The launchers above are disposable commands, not the real desktop.
            delete process.env.WLD_TEST_SANDBOX_HOME;
            await run(async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean));
        } finally {
            if (previousSandbox === undefined) delete process.env.WLD_TEST_SANDBOX_HOME;
            else process.env.WLD_TEST_SANDBOX_HOME = previousSandbox;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(root, { recursive: true, force: true });
        }
    });
}

test(
    "authenticated remote browser opens forwarded and public links on the laptop without changing tokens",
    { skip: process.platform === "win32" },
    async () => {
        await withLaptopBrowser(async (opened) => {
            const service = startRemoteControlService(identity, undefined, undefined, origin);
            const connection = { port: service.port, credential: service.credential };
            const browser = createRemoteBrowserPort(connection);
            const logs: string[] = [];
            const previousLog = console.log;
            const previousError = console.error;
            console.log = (...values) => {
                logs.push(values.map(String).join(" "));
            };
            console.error = (...values) => {
                logs.push(values.map(String).join(" "));
            };
            const token = "private-review-token-9a7b";
            try {
                for (const route of ["handshake", "readiness"]) {
                    const response = await fetch(`http://127.0.0.1:${service.port}/${route}`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${service.credential}` },
                        body: JSON.stringify(identity),
                    });
                    assert.equal(response.status, 200);
                    await response.text();
                }
                const reviewUrl = `${origin}/review/plan?token=${token}&file=hello%20world#section`;
                assert.equal(await browser.open(reviewUrl), true);
                assert.equal(await browser.open("https://1.1.1.1/docs?q=remote"), true);
                assert.equal(await browser.open("https://[2606:4700:4700::1111]/docs"), true);
                assert.deepEqual(await opened(), [
                    reviewUrl,
                    "https://1.1.1.1/docs?q=remote",
                    "https://[2606:4700:4700::1111]/docs",
                ]);
                for (const url of [
                    "http://127.0.0.1:43128/review/plan",
                    "http://localhost:43127/review/plan",
                    "file:///tmp/plan.md",
                    "not a URL",
                    "http://10.0.0.1/",
                    "http://127.0.0.1.nip.io:43128/",
                    "http://10.0.0.1.nip.io/",
                    "https://does-not-exist.invalid/",
                    ...[
                        "0.0.0.0",
                        "100.64.0.1",
                        "169.254.1.1",
                        "172.16.0.1",
                        "192.0.0.8",
                        "192.0.2.1",
                        "192.88.99.1",
                        "192.168.1.1",
                        "198.18.0.1",
                        "198.51.100.1",
                        "203.0.113.1",
                        "224.0.0.1",
                        "240.0.0.1",
                        "255.255.255.255",
                    ].map((ip) => `https://${ip}/`),
                    ...[
                        "::",
                        "::ffff:127.0.0.1",
                        "fc00::1",
                        "fe80::1",
                        "ff02::1",
                        "2001:db8::1",
                        "2001::1",
                        "2002:7f00:1::",
                        "3fff::1",
                        "64:ff9b::7f00:1",
                    ].map((ip) => `https://[${ip}]/`),
                    "http://[::1]/",
                    "https://user:password@example.com/",
                    "http://printer.local/",
                ]) {
                    const response = await fetch(`http://127.0.0.1:${service.port}/browser/open`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${service.credential}` },
                        body: JSON.stringify({ url }),
                    });
                    assert.equal(response.status, 400, url);
                    await response.text();
                    assert.equal(await browser.open(url), false, url);
                }
                assert.deepEqual(await opened(), [
                    reviewUrl,
                    "https://1.1.1.1/docs?q=remote",
                    "https://[2606:4700:4700::1111]/docs",
                ]);
                assert.equal(logs.join("\n").includes(token), false);
                assert.equal(logs.join("\n").includes(service.credential), false);
            } finally {
                console.log = previousLog;
                console.error = previousError;
                await service.close();
            }
            assert.equal(await browser.open(`${origin}/review/plan`), false);
        });
    },
);

test(
    "browser control refuses missing credentials, pre-readiness, and shutdown without opening anything",
    { skip: process.platform === "win32" },
    async () => {
        await withLaptopBrowser(async (opened) => {
            const service = startRemoteControlService(identity, undefined, undefined, origin);
            const request = async (
                route: string,
                credential = service.credential,
                body = JSON.stringify({ url: `${origin}/review/plan?token=secret` }),
            ) => {
                const response = await fetch(`http://127.0.0.1:${service.port}/${route}`, {
                    method: "POST",
                    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
                    body,
                });
                await response.text();
                return response.status;
            };
            try {
                assert.equal(await request("browser/open", ""), 401);
                assert.equal(await request("browser/open", "wrong"), 401);
                assert.equal(await request("browser/open"), 403);
                assert.equal(await request("handshake", service.credential, JSON.stringify(identity)), 200);
                assert.equal(await request("browser/open"), 403);
                assert.equal(await request("readiness"), 200);
                assert.equal(await request("browser/open", service.credential, "{"), 400);
                assert.equal(await request("browser/open", service.credential, JSON.stringify({ url: 42 })), 400);
                assert.equal(await request("browser/open", service.credential, " ".repeat(16_385)), 413);
                const wrongMethod = await fetch(`http://127.0.0.1:${service.port}/browser/open`, {
                    headers: { Authorization: `Bearer ${service.credential}` },
                });
                assert.equal(wrongMethod.status, 405);
                await wrongMethod.text();
                assert.equal(await request("shutdown"), 200);
                assert.equal(await request("browser/open"), 403);
                assert.deepEqual(await opened(), []);
            } finally {
                await service.close();
            }
        });
    },
);

test(
    "laptop DNS requires all public A and AAAA answers and fails closed on unknown or timed-out resolution",
    { skip: process.platform === "win32" },
    async () => {
        await withLaptopBrowser(async (opened) => {
            const url = "https://example.com/docs?q=remote";
            let answer: LookupAddress[] = [
                { address: "1.1.1.1", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 },
            ];
            let failure = false;
            let pending = false;
            const resolver = mock.method(
                dns,
                "lookup",
                async (host: string, options: import("node:dns").LookupAllOptions) => {
                    assert.equal(host, "example.com");
                    assert.deepEqual(options, { all: true, verbatim: true });
                    if (failure) throw new Error("DNS unavailable");
                    if (pending) return await new Promise<LookupAddress[]>(() => {});
                    return answer;
                },
            );
            const open = () =>
                handleBrowserOpen(
                    new Request("http://localhost/browser/open", { method: "POST", body: JSON.stringify({ url }) }),
                    origin,
                    () => true,
                );
            try {
                assert.equal((await open()).status, 200);
                for (const privateAddress of [
                    { address: "127.0.0.1", family: 4 },
                    { address: "fd00::1", family: 6 },
                ]) {
                    answer = [{ address: "1.1.1.1", family: 4 }, privateAddress];
                    assert.equal((await open()).status, 400);
                }
                answer = [];
                assert.equal((await open()).status, 400);
                failure = true;
                assert.equal((await open()).status, 400);
                failure = false;
                pending = true;
                const started = performance.now();
                assert.equal((await open()).status, 400);
                assert(performance.now() - started < 5_000, "DNS must not hold a browser request indefinitely");
                assert.deepEqual(await opened(), [url]);
            } finally {
                resolver.mock.restore();
            }
        });
    },
);
