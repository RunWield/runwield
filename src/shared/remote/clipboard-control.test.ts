import { stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { startRemoteControlService } from "./control.ts";
import {
    clipboardIdentity,
    clipboardImage,
    controlRequest,
    laptopClipboardFixture,
    readyClipboardService,
} from "./clipboard-test-fixture.ts";
import process from "node:process";

test("laptop clipboard requires authentication, handshake, and readiness without a transcript owner", async () => {
    const service = startRemoteControlService(clipboardIdentity);
    try {
        assertEquals((await fetch(`http://127.0.0.1:${service.port}/clipboard/image`)).status, 401);
        assertEquals(
            (
                await fetch(`http://127.0.0.1:${service.port}/clipboard/image`, {
                    headers: { Authorization: `Bearer ${"d".repeat(64)}` },
                })
            ).status,
            401,
        );
        assertEquals((await controlRequest(service, "/clipboard/image")).status, 403);
        await (await controlRequest(service, "/handshake", "POST", JSON.stringify(clipboardIdentity))).text();
        assertEquals((await controlRequest(service, "/clipboard/image")).status, 403);
        await readyClipboardService(service);
        assertEquals((await controlRequest(service, "/clipboard/image", "POST")).status, 405);
        service.requestShutdown();
        assertEquals((await controlRequest(service, "/clipboard/image")).status, 403);
    } finally {
        await service.close();
    }
});

test("laptop clipboard reports no image as null", async () => {
    const fixture = await laptopClipboardFixture("none");
    try {
        await fixture.ready();
        const response = await fetch(`http://127.0.0.1:${fixture.connection.port}/clipboard/image`, {
            headers: { Authorization: `Bearer ${fixture.connection.credential}` },
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), null);
    } finally {
        await fixture.close();
    }
});

test(
    "laptop clipboard exports local image bytes before the first message, never its selected remote reader",
    { skip: (process.platform === "win32" ? "windows" : process.platform) !== "darwin" },
    async () => {
        const fixture = await laptopClipboardFixture("image", true);
        try {
            await fixture.ready();
            const response = await fetch(`http://127.0.0.1:${fixture.connection.port}/clipboard/image`, {
                headers: { Authorization: `Bearer ${fixture.connection.credential}` },
            });
            assertEquals(response.status, 200);
            assertEquals(await response.json(), clipboardImage);
        } finally {
            await fixture.close();
        }
    },
);

test(
    "laptop clipboard rejects an image above the body limit",
    { skip: (process.platform === "win32" ? "windows" : process.platform) !== "darwin" },
    async () => {
        const fixture = await laptopClipboardFixture("large");
        try {
            await fixture.ready();
            const response = await fetch(`http://127.0.0.1:${fixture.connection.port}/clipboard/image`, {
                headers: { Authorization: `Bearer ${fixture.connection.credential}` },
            });
            assertEquals(response.status, 503);
            await response.text();
        } finally {
            await fixture.close();
        }
    },
);

test(
    "laptop clipboard discards an in-flight image after shutdown",
    { skip: (process.platform === "win32" ? "windows" : process.platform) !== "darwin" },
    async () => {
        const fixture = await laptopClipboardFixture("wait");
        try {
            await fixture.ready();
            const pending = fetch(`http://127.0.0.1:${fixture.connection.port}/clipboard/image`, {
                headers: { Authorization: `Bearer ${fixture.connection.credential}` },
            });
            const deadline = Date.now() + 4000;
            while (Date.now() < deadline) {
                try {
                    await fsStat(`${fixture.modePath}.started`);
                    break;
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }
            await fsStat(`${fixture.modePath}.started`);
            await (
                await fetch(`http://127.0.0.1:${fixture.connection.port}/shutdown`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${fixture.connection.credential}` },
                })
            ).text();
            await fsWriteFile(fixture.modePath, "image");
            assertEquals((await pending).status, 403);
        } finally {
            await fixture.close();
        }
    },
);
