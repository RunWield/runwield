import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompileCommand } from "./compile-command.ts";
import { verifyBuildArtifact } from "./build-metadata.ts";
import { captureScriptProcess } from "./script-process.ts";

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

test("remote compile accepts a bundle output and rejects a single explicit target", () => {
    deepStrictEqual(parseCompileCommand(["--remote", "--output", "a directory/wld"]), {
        output: "a directory/wld",
        remote: true,
    });
    throws(() => parseCompileCommand(["--remote", "--target", "bun-linux-x64"]), /cannot be combined/);
});

test("remote compile produces adjacent Linux runtimes matching the embedded launcher identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "wld-remote-compile-"));
    const launcher = join(root, process.platform === "win32" ? "wld.exe" : "wld");
    try {
        const build = await captureScriptProcess(process.execPath, {
            args: ["scripts/compile-command.ts", "--remote", "--output", launcher],
            signal: AbortSignal.timeout(120_000),
        });
        deepStrictEqual(build.code, 0, new TextDecoder().decode(build.stderr));
        const preflight = await captureScriptProcess(launcher, { args: ["--remote-preflight"] });
        deepStrictEqual(preflight.code, 0, new TextDecoder().decode(preflight.stderr));
        const identity = JSON.parse(new TextDecoder().decode(preflight.stdout));
        const local = await verifyBuildArtifact(launcher);
        deepStrictEqual(local.buildId, identity.buildId);
        for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
            const metadata = await verifyBuildArtifact(join(root, `wld-${target}`));
            deepStrictEqual(
                {
                    buildId: metadata.buildId,
                    protocol: metadata.protocol,
                    version: metadata.version,
                    target: metadata.target,
                },
                { buildId: identity.buildId, protocol: identity.protocol, version: identity.version, target },
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
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
