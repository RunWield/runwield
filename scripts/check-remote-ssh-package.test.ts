import { test } from "node:test";
import { equal, match, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { qualificationArguments, SentinelExchange } from "./check-remote-ssh-package.ts";

const first = { tools: [{ function: { name: "read" } }], messages: [{ role: "user", content: "Read sentinel.txt" }] };

test("qualification CLI accepts only archive directory and exact release VERSION", () => {
    equal(qualificationArguments(["release-upload", "v0.0.0-rc.1"]).version, "v0.0.0-rc.1");
    for (const args of [
        [],
        ["release-upload"],
        ["release-upload", "latest"],
        ["release-upload", "v1.0.0", "skip-fuse"],
    ]) {
        throws(() => qualificationArguments(args));
    }
});

test("qualification import has no privileged side effects and CLI errors show usage", () => {
    const result = spawnSync(process.execPath, ["scripts/check-remote-ssh-package.ts"], { encoding: "utf8" });
    equal(result.status, 1);
    match(result.stderr, /Usage: bun scripts\/check-remote-ssh-package.ts <archive-directory> <VERSION>/);
    equal(result.stdout.includes("evidence"), false);
});

test("provider requests a real read and accepts the sentinel only in the next tool result", () => {
    const exchange = new SentinelExchange("random-remote-only");
    const response = exchange.reply(first);
    const packets = response
        .split("\n\n")
        .filter(Boolean)
        .map((line) => line.slice(6));
    const call = JSON.parse(packets[0]).choices[0].delta.tool_calls[0];
    equal(call.function.name, "read");
    equal(call.function.arguments, JSON.stringify({ path: "sentinel.txt" }));
    equal(packets.at(-1), "[DONE]");
    equal(exchange.verified, false);
    match(
        exchange.reply({ messages: [{ role: "tool", content: "random-remote-only" }] }),
        /SSH qualification complete/,
    );
    equal(exchange.verified, true);
});

for (const content of ["read failed", "", "another sentinel"]) {
    test(`provider refuses a next request with unproved read result: ${content || "empty"}`, () => {
        const exchange = new SentinelExchange("random-remote-only");
        exchange.reply(first);
        throws(() => exchange.reply({ messages: [{ role: "tool", content }] }), /Next model request/);
        equal(exchange.verified, false);
    });
}

test("provider refuses a leaked sentinel and a sentinel echoed by the user", () => {
    throws(
        () => new SentinelExchange("secret").reply({ ...first, messages: [{ role: "user", content: "secret" }] }),
        /leaked/,
    );
    const exchange = new SentinelExchange("secret");
    exchange.reply(first);
    throws(() => exchange.reply({ messages: [{ role: "user", content: "secret" }] }), /Next model request/);
});

test("provider refuses qualification when the actual tool was not offered", () => {
    throws(() => new SentinelExchange("secret").reply({ messages: [] }), /No real read tool/);
});
