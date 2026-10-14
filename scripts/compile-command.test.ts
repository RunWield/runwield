import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert/strict";
import { parseCompileCommand } from "./compile-command.ts";

test("development compile preserves named output, canonical target and expected identity", () => {
    deepStrictEqual(
        parseCompileCommand([
            "--output",
            "a directory/wld",
            "--target=x86_64-unknown-linux-gnu",
            "--expect-build-id=abc",
        ]),
        {
            output: "a directory/wld",
            target: "bun-linux-x64",
            expectBuildId: "abc",
        },
    );
    deepStrictEqual(parseCompileCommand(["--output=wld.exe", "--target", "bun-windows-arm64"]), {
        output: "wld.exe",
        target: "bun-windows-arm64",
    });
    for (const args of [
        ["--output"],
        ["--output="],
        ["--target", "--output", "wld"],
        ["--target", "unsupported"],
        ["--bogus"],
    ]) {
        throws(() => parseCompileCommand(args));
    }
});

test("compile accepts every original platform target and rejects dependency reload explicitly", () => {
    for (const [canonical, bun] of [
        ["aarch64-apple-darwin", "bun-darwin-arm64"],
        ["x86_64-apple-darwin", "bun-darwin-x64"],
        ["aarch64-unknown-linux-gnu", "bun-linux-arm64"],
        ["x86_64-unknown-linux-gnu", "bun-linux-x64"],
        ["aarch64-pc-windows-msvc", "bun-windows-arm64"],
        ["x86_64-pc-windows-msvc", "bun-windows-x64"],
    ]) {
        deepStrictEqual(parseCompileCommand(["--target", canonical]).target, bun);
    }
    throws(() => parseCompileCommand(["--reload"]), /Deno-specific.*frozen-install/);
});
