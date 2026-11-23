import { test } from "node:test";
import { doesNotThrow, equal, match, throws } from "node:assert";
import { execPath, platform, versions } from "node:process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readPinnedBunVersion, requireSupportedBun } from "./check-bun-runtime.ts";

for (const version of ["1.4.0", "1.4.3", "1.4.4", "1.5.0", "1.99.0"]) {
    test(`local commands accept Bun ${version}`, () => {
        const descriptor = Object.getOwnPropertyDescriptor(versions, "bun")!;
        try {
            Object.defineProperty(versions, "bun", { ...descriptor, value: version });
            doesNotThrow(() => requireSupportedBun());
        } finally {
            Object.defineProperty(versions, "bun", descriptor);
        }
    });
}

for (const version of ["1.3.12", "2.0.0", "1.4.0-canary.1", undefined].filter(
    (item) => item !== readPinnedBunVersion(),
)) {
    test(`local commands reject ${version ? `Bun ${version}` : "another runtime"}`, () => {
        const descriptor = Object.getOwnPropertyDescriptor(versions, "bun")!;
        try {
            Object.defineProperty(versions, "bun", { ...descriptor, value: version });
            throws(() => requireSupportedBun(), {
                message: `RunWield uses Bun ${readPinnedBunVersion()} from .bun-version and also supports ^1.4.0; found ${version || "another runtime"}.`,
            });
        } finally {
            Object.defineProperty(versions, "bun", descriptor);
        }
    });
}

test("changing only the checkout version selects a runtime beyond the local compatibility range", () => {
    const root = mkdtempSync(join(tmpdir(), "runwield-bun-upgrade-"));
    try {
        const scripts = join(root, "scripts");
        mkdirSync(scripts);
        const check = join(scripts, "check-bun-runtime.ts");
        copyFileSync(new URL("./check-bun-runtime.ts", import.meta.url), check);
        writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { bun: "<0.1.0" } }));
        const pin = join(root, ".bun-version");
        writeFileSync(pin, "0.1.0\n");
        equal(spawnSync(execPath, [check]).status, 1);
        writeFileSync(pin, `${versions.bun}\n`);
        equal(spawnSync(execPath, [check]).status, 0);
    } finally {
        rmSync(root, { force: true, recursive: true });
    }
});

test(
    "local launcher reads the version from its own checkout for every invocation",
    { skip: platform === "win32" },
    () => {
        const root = mkdtempSync(join(tmpdir(), "runwield-bun-selection-"));
        try {
            const scripts = join(root, "scripts");
            mkdirSync(scripts);
            for (const file of ["with-bun.sh", "read-bun-version.sh"]) {
                copyFileSync(new URL(file, import.meta.url), join(scripts, file));
            }
            const bun = join(root, "bun");
            writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 8.0.0; else printf "%s\\n" "$@"; fi\n');
            chmodSync(bun, 0o700);
            for (const version of ["8.0.0", "9.0.0"]) {
                writeFileSync(join(root, ".bun-version"), version + "\n");
                const result = spawnSync("sh", [join(scripts, "with-bun.sh"), "run", "a task"], {
                    cwd: tmpdir(),
                    encoding: "utf8",
                    env: { PATH: root + ":/usr/bin:/bin" },
                });
                equal(result.status, 0, result.stderr);
                equal(result.stdout, version === "8.0.0" ? "run\na task\n" : `x\nbun@${version}\nrun\na task\n`);
            }
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    },
);

test("the container pin is required, checked against the actual runtime, and not duplicated", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const recipe = source("../Containerfile");
    match(recipe, /^ARG BUN_VERSION$/m);
    equal(/^ARG BUN_VERSION=/m.test(recipe), false);
    match(recipe, /^FROM docker\.io\/oven\/bun:\$\{BUN_VERSION\} AS bun-base$/m);
    match(recipe, /^FROM bun-base AS builder$/m);
    match(recipe, /^FROM bun-base$/m);
    match(recipe, /expected=\$\(sh scripts\/read-bun-version\.sh\).*actual=\$\(bun --version\)/);
    match(recipe, /"\$BUN_VERSION" != "\$expected".*"\$actual" != "\$expected"/);
    match(source("../compose.yml"), /BUN_VERSION: \$\{BUN_VERSION:\?/);
    match(
        source("../.github/workflows/release-containers.yml"),
        /container: \$\{\{ needs\.bun-pin\.outputs\.image \}\}/,
    );
    for (const path of ["../package.json", "../docs-site/package.json"]) {
        equal(/"packageManager"\s*:\s*"bun@\d/.test(source(path)), false, path);
    }
    for (const path of [
        "../Containerfile",
        "../.github/workflows/release-containers.yml",
        "../.github/workflows/release-windows.yml",
        "./check-remote-container.ts",
    ]) {
        equal(
            /oven\/bun:\d|bun-v\d+\.\d+\.\d+|(?:bun --version|versions\.bun)[^\n]*1\.\d+\.\d+/.test(source(path)),
            false,
            path,
        );
    }
});

test(
    "Docker, Podman and Compose launch with the checkout pin, not a host override",
    {
        skip: platform === "win32",
    },
    () => {
        const root = mkdtempSync(join(tmpdir(), "runwield-container-pin-"));
        try {
            const scripts = join(root, "scripts");
            const bin = join(root, "bin");
            mkdirSync(scripts);
            mkdirSync(bin);
            for (const name of ["read-bun-version.sh", "plan-server-container.sh"]) {
                copyFileSync(new URL(name, import.meta.url), join(scripts, name));
            }
            for (const name of ["docker", "podman"]) {
                const engine = join(bin, name);
                writeFileSync(engine, '#!/bin/sh\nprintf "%s\\n" "$BUN_VERSION" "$@"\n');
                chmodSync(engine, 0o700);
            }
            const pin = join(root, ".bun-version");
            const wrapper = join(scripts, "plan-server-container.sh");
            const run = (engine: string, ...args: string[]) =>
                spawnSync("sh", [wrapper, ...args], {
                    encoding: "utf8",
                    env: {
                        PATH: `${bin}:/usr/bin:/bin`,
                        BUN_VERSION: "9.9.9",
                        RUNWIELD_CONTAINER_ENGINE: engine,
                    },
                });
            for (const bad of ["", " 1.5.9", "1.5.9-canary", "1.5.9\n2.0.0", "1.5.9/other"]) {
                writeFileSync(pin, `${bad}\n`);
                equal(run("docker", "build").status, 1);
                match(run("docker", "build").stderr, /Expected one stable Bun version/);
                throws(() => readPinnedBunVersion(pathToFileURL(pin)), /Expected one stable Bun version/);
            }
            rmSync(pin);
            equal(run("podman", "compose", "config").status, 1);
            for (const version of ["1.5.9", "1.6.0"]) {
                writeFileSync(pin, `${version}\n`);
                equal(readPinnedBunVersion(pathToFileURL(pin)), version);
                for (const engine of ["docker", "podman"]) {
                    const build = run(engine, "build", "-t", "plan:test");
                    equal(build.status, 0, build.stderr);
                    equal(
                        build.stdout,
                        `${version}\nbuild\n-f\nContainerfile\n-t\nplan:test\n--build-arg\nBUN_VERSION=${version}\n.\n`,
                    );
                    const compose = run(engine, "compose", "up", "-d");
                    equal(compose.status, 0, compose.stderr);
                    equal(compose.stdout, `${version}\ncompose\n-f\ncompose.yml\nup\n-d\n`);
                }
            }
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    },
);
