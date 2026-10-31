import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PLAN_UI_TOKEN_HEADER } from "../../../constants.js";
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { configureRemoteReviewHost, reviewHost } from "./review-host.ts";

const onError = () => new Response("failed", { status: 500 });

function register(token: string) {
    return reviewHost.register(token, (request) => new Response(`${token}:${new URL(request.url).pathname}`), {
        onError,
    });
}

async function text(origin: string, path: string, headers?: HeadersInit): Promise<string> {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 200);
    return response.text();
}

test("review registrations share an origin and dispatch every token source without rewriting requests", async () => {
    const a = register("A");
    const b = register("B");
    try {
        assert.equal(a.origin, b.origin);
        assert.equal(await text(a.origin, "/review/plan?token=A"), "A:/review/plan");
        assert.equal(await text(a.origin, "/review/plan?token=B"), "B:/review/plan");
        assert.equal(await text(a.origin, "/api/test", { [PLAN_UI_TOKEN_HEADER]: "B" }), "B:/api/test");
        assert.equal(await text(a.origin, "/api/test", { "x-runwield-review-token": "A" }), "A:/api/test");
        assert.equal(
            await text(a.origin, "/api/image", { referer: `${a.origin}/review/plan?token=B` }),
            "B:/api/image",
        );
    } finally {
        await a.release();
        await b.release();
    }
});

test("dispatch chooses the first registered token source and skips unregistered sources", async () => {
    const a = register("A");
    const b = register("B");
    try {
        const headers = {
            [PLAN_UI_TOKEN_HEADER]: "B",
            "x-runwield-review-token": "A",
            referer: `${a.origin}/review/plan?token=B`,
        };
        assert.equal(await text(a.origin, "/api/test?token=A", headers), "A:/api/test");
        assert.equal(await text(a.origin, "/api/test?token=unknown", headers), "B:/api/test");
        assert.equal(
            await text(a.origin, "/api/test", {
                ...headers,
                [PLAN_UI_TOKEN_HEADER]: "unknown",
            }),
            "A:/api/test",
        );
        assert.equal(await text(a.origin, "/api/test?token=B", { referer: "not a URL" }), "B:/api/test");
    } finally {
        await a.release();
        await b.release();
    }
});

test("unknown or absent tokens fail closed while public assets need no token", async () => {
    const a = register("A");
    try {
        for (const path of ["/review/plan?token=unknown", "/review/plan"]) {
            const response = await fetch(`${a.origin}${path}`);
            assert.equal(response.status, 401);
            assert.equal(response.headers.get("cache-control"), "no-store");
            await response.text();
        }
        assert.equal(await text(a.origin, "/tokens.css"), "A:/tokens.css");
    } finally {
        await a.release();
    }
});

test("release revokes only its token and can be repeated even after that token is registered again", async () => {
    const a = register("A");
    const b = register("B");
    try {
        await a.release();
        const response = await fetch(`${b.origin}/review/plan?token=A`);
        assert.equal(response.status, 401);
        await response.text();
        assert.equal(await text(b.origin, "/review/plan?token=B"), "B:/review/plan");
        const replacement = register("A");
        try {
            await a.release();
            assert.equal(await text(replacement.origin, "/review/plan?token=A"), "A:/review/plan");
        } finally {
            await replacement.release();
        }
    } finally {
        await a.release();
        await b.release();
    }
});

test("last release closes the listener before it resolves", async () => {
    const a = register("A");
    assert.equal(await text(a.origin, "/review/plan?token=A"), "A:/review/plan");
    await a.release();
    await assert.rejects(fetch(`${a.origin}/review/plan?token=A`, { keepalive: false }));
});

test("registration during shutdown starts a working listener without waiting for the draining request", async () => {
    let finish!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
        finish = resolve;
    });
    const a = reviewHost.register(
        "A",
        () => {
            entered();
            return pending;
        },
        { onError },
    );
    const request = fetch(`${a.origin}/review/plan?token=A`);
    await started;
    let drained = false;
    const release = a.release().then(() => {
        drained = true;
    });
    const b = register("B");
    try {
        assert.equal(await text(b.origin, "/review/plan?token=B"), "B:/review/plan");
        assert.equal(drained, false);
        finish(new Response("finished"));
        assert.equal(await (await request).text(), "finished");
        await release;
        assert.equal(await text(b.origin, "/review/plan?token=B"), "B:/review/plan");
    } finally {
        finish(new Response("finished"));
        await release;
        await b.release();
    }
});

test("handler failures use that registration's error response without stopping other reviews", async () => {
    const a = reviewHost.register("A", () => Promise.reject(new Error("A failed")), {
        onError: (error) => new Response(error.message, { status: 503 }),
    });
    const b = register("B");
    try {
        const response = await fetch(`${a.origin}/review/plan?token=A`);
        assert.equal(response.status, 503);
        assert.equal(await response.text(), "A failed");
        assert.equal(await text(b.origin, "/review/plan?token=B"), "B:/review/plan");
    } finally {
        await a.release();
        await b.release();
    }
});

test("duplicate live tokens are rejected without replacing their handler", async () => {
    const a = register("A");
    try {
        assert.throws(() => register("A"), /already registered/);
        assert.equal(await text(a.origin, "/review/plan?token=A"), "A:/review/plan");
    } finally {
        await a.release();
    }
});

test(
    "remote review host serves tokens over its Unix socket and publishes only the laptop origin",
    { skip: process.platform === "win32" },
    async () => {
        const directory = `/tmp/wld-remote-${randomBytes(16).toString("hex")}`;
        const socketPath = `${directory}/review.sock`;
        await mkdir(directory, { mode: 0o700 });
        const reservation = createServer();
        await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const address = reservation.address();
        assert(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
        const clear = configureRemoteReviewHost({ socketPath, origin });
        try {
            assert.throws(() => configureRemoteReviewHost({ socketPath, origin }), /already configured/);
            for (let cycle = 0; cycle < 2; cycle++) {
                const registration = register("remote-token");
                try {
                    assert.equal(registration.origin, origin);
                    assert.equal((await stat(socketPath)).isSocket(), true);
                    const response = await fetch(`${origin}/review/plan?token=remote-token`, { unix: socketPath });
                    assert.equal(response.status, 200);
                    assert.equal(await response.text(), "remote-token:/review/plan");
                    const denied = await fetch(`${origin}/review/plan?token=unknown`, { unix: socketPath });
                    assert.equal(denied.status, 401);
                    await denied.text();
                    await assert.rejects(fetch(`${origin}/review/plan?token=remote-token`, { keepalive: false }));
                } finally {
                    await registration.release();
                }
            }
        } finally {
            clear();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test("remote review configuration cannot replace a live local host", async () => {
    const registration = register("local");
    try {
        assert.throws(
            () =>
                configureRemoteReviewHost({
                    socketPath: `/tmp/wld-remote-${"a".repeat(32)}/review.sock`,
                    origin: "http://127.0.0.1:43127",
                }),
            /already configured or listening/,
        );
        assert.equal(await text(registration.origin, "/review/plan?token=local"), "local:/review/plan");
    } finally {
        await registration.release();
    }
});
