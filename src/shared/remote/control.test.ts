import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { type RemoteControlService, startRemoteControlService } from "./control.ts";

const identity = { buildId: "a".repeat(64), protocol: 1 };

function request(service: RemoteControlService, action: string, credential = service.credential, body?: string) {
    return fetch(`http://127.0.0.1:${service.port}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body,
    });
}

test("remote control admits only a matching handshake before readiness", async () => {
    const service = startRemoteControlService(identity);
    try {
        assertEquals((await request(service, "readiness")).status, 403);
        assertEquals((await fetch(`http://127.0.0.1:${service.port}/models/catalog`)).status, 401);
        assertEquals(
            (await fetch(`http://127.0.0.1:${service.port}/models/catalog`, {
                headers: { Authorization: `Bearer ${service.credential}` },
            })).status,
            403,
        );
        assertEquals(
            (await request(service, "handshake", service.credential, JSON.stringify({ ...identity, protocol: 2 })))
                .status,
            409,
        );
        assertEquals(service.status().connected, false);
        assertEquals((await request(service, "handshake", service.credential, JSON.stringify(identity))).status, 200);
        assertEquals((await request(service, "readiness")).status, 200);
        assertEquals(service.status().ready, true);
        assertEquals((await request(service, "health")).status, 200);
        assertEquals(service.status().shutdown, false);
    } finally {
        await service.close();
    }
});

test("wrong and prior credentials cannot stop a valid connection", async () => {
    const prior = startRemoteControlService(identity);
    const oldCredential = prior.credential;
    await prior.close();
    const service = startRemoteControlService(identity);
    try {
        assertNotEquals(oldCredential, service.credential);
        assertEquals((await request(service, "handshake", oldCredential, JSON.stringify(identity))).status, 401);
        assertEquals((await fetch(`http://127.0.0.1:${service.port}/shutdown`, { method: "POST" })).status, 401);
        await request(service, "handshake", service.credential, JSON.stringify(identity));
        assertEquals((await request(service, "shutdown", "x".repeat(64))).status, 401);
        assertEquals(service.status().shutdown, false);
        assertEquals((await request(service, "shutdown")).status, 200);
        assertEquals(service.status().shutdown, true);
    } finally {
        await service.close();
    }
});

test("three missed remote health checks revoke readiness", async () => {
    const service = startRemoteControlService(identity);
    try {
        await request(service, "handshake", service.credential, JSON.stringify(identity));
        await request(service, "readiness");
        const deadline = Date.now() + 20_000;
        while (!service.status().shutdown && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assertEquals(service.status().shutdown, true);
        assertEquals(service.status().ready, false);
    } finally {
        await service.close();
    }
});

test("local shutdown revokes readiness and closing revokes admission", async () => {
    const service = startRemoteControlService(identity);
    await request(service, "handshake", service.credential, JSON.stringify(identity));
    await request(service, "readiness");
    service.requestShutdown();
    assertEquals(service.status().ready, false);
    assertEquals(await (await request(service, "health")).json(), { shutdown: true });
    await service.close();
    assertEquals(service.status().closed, true);
});
