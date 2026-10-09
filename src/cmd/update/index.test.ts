import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { VERSION } from "../../shared/version.js";
import { parseRunWieldReleaseVersion } from "../../shared/update-check.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { type InstallerProcessPort, type ProcessExitPort, runUpdateCommand, type UpdateNetworkPort } from "./index.ts";

interface InstallerInvocation {
    script: string;
    scriptPath: string;
    releaseTag: string;
    env: Record<string, string>;
}

interface InstallerFixture {
    invocations: InstallerInvocation[];
    port: InstallerProcessPort;
}

function makeJsonResponse(data: Record<string, string>, status = 200): Response {
    return new Response(JSON.stringify(data), { status });
}

function createNetworkFixture(
    releaseResponse: Response,
    installerResponse = new Response("#!/usr/bin/env bash\n"),
): { port: UpdateNetworkPort; urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        port: {
            fetch: (input) => {
                const url = String(input);
                urls.push(url);
                return Promise.resolve(
                    url.includes("api.github.com") ? releaseResponse.clone() : installerResponse.clone(),
                );
            },
        },
    };
}

function createInstallerFixture(exitCode = 0): InstallerFixture {
    const invocations: InstallerInvocation[] = [];
    return {
        invocations,
        port: {
            run: async (scriptPath, releaseTag, env) => {
                invocations.push({
                    script: await Deno.readTextFile(scriptPath),
                    scriptPath,
                    releaseTag,
                    env: { ...env },
                });
                return exitCode;
            },
        },
    };
}

function createExitFixture(): { codes: number[]; port: ProcessExitPort } {
    const codes: number[] = [];
    return { codes, port: { exit: (code) => codes.push(code) } };
}

async function captureConsole(run: () => void | Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message = "") => logs.push(String(message));
    console.error = (message = "") => errors.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return { logs, errors };
}

async function assertRemoved(path: string): Promise<void> {
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
}

Deno.test("update downloads the pinned installer, writes a real temp script, executes it, and cleans up", async () => {
    await withProcessGlobalTestLock(async () => {
        const network = createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" }));
        const installer = createInstallerFixture();

        const output = await captureConsole(() =>
            runUpdateCommand([], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            })
        );

        assertEquals(network.urls, [
            "https://api.github.com/repos/gandazgul/runwield/releases/latest",
            "https://raw.githubusercontent.com/gandazgul/runwield/v999.0.0/install.sh",
        ]);
        assertEquals(installer.invocations.length, 1);
        const invocation = installer.invocations[0];
        assertEquals(invocation.script, "#!/usr/bin/env bash\n");
        assertEquals(invocation.releaseTag, "v999.0.0");
        assertStringIncludes(output.logs.join("\n"), "running from source");
        await assertRemoved(dirname(invocation.scriptPath));
    });
});

Deno.test("update falls back to the GitHub web raw installer URL after raw.githubusercontent.com returns 403", async () => {
    const urls: string[] = [];
    const network: { port: UpdateNetworkPort } = {
        port: {
            fetch: (input) => {
                const url = String(input);
                urls.push(url);
                if (url.includes("api.github.com")) return Promise.resolve(makeJsonResponse({ tag_name: "v999.0.0" }));
                if (url.includes("raw.githubusercontent.com")) {
                    return Promise.resolve(new Response("forbidden", { status: 403 }));
                }
                return Promise.resolve(new Response("#!/usr/bin/env bash\n# fallback\n"));
            },
        },
    };
    const installer = createInstallerFixture();

    await runUpdateCommand([], {
        networkPort: network.port,
        installerPort: installer.port,
        exitPort: createExitFixture().port,
    });

    assertEquals(urls, [
        "https://api.github.com/repos/gandazgul/runwield/releases/latest",
        "https://raw.githubusercontent.com/gandazgul/runwield/v999.0.0/install.sh",
        "https://github.com/gandazgul/runwield/raw/refs/tags/v999.0.0/install.sh",
    ]);
    assertEquals(installer.invocations[0].script, "#!/usr/bin/env bash\n# fallback\n");
});

Deno.test("update passes the real WLD_INSTALL_DIR environment override to the installer", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousInstallDir = Deno.env.get("WLD_INSTALL_DIR");
        Deno.env.set("WLD_INSTALL_DIR", "/fixture/custom/bin");
        const network = createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" }));
        const installer = createInstallerFixture();
        try {
            await runUpdateCommand([], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            });
            assertEquals(installer.invocations[0].env.WLD_INSTALL_DIR, "/fixture/custom/bin");
        } finally {
            if (previousInstallDir === undefined) Deno.env.delete("WLD_INSTALL_DIR");
            else Deno.env.set("WLD_INSTALL_DIR", previousInstallDir);
        }
    });
});

Deno.test("update rejects arguments through the real usage formatter before external work", async () => {
    await withProcessGlobalTestLock(async () => {
        const exits = createExitFixture();
        const output = await captureConsole(() =>
            runUpdateCommand(["extra"], {
                networkPort: createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" })).port,
                installerPort: createInstallerFixture().port,
                exitPort: exits.port,
            })
        );

        assertEquals(output.errors, [
            "Usage: wld update [--rc | --to <tag>] [--downgrade] [--yes]\n       wld upgrade [--rc | --to <tag>] [--downgrade] [--yes]",
        ]);
        assertEquals(exits.codes, [1]);
    });
});

Deno.test("update installs latest RC only after confirmation", async () => {
    await withProcessGlobalTestLock(async () => {
        const prompts: string[] = [];
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = (message = "") => {
            prompts.push(message);
            return "y";
        };
        try {
            const network = createNetworkFixture(
                new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.2", prerelease: true, draft: false }])),
            );
            const installer = createInstallerFixture();

            await runUpdateCommand(["--rc"], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            });

            assertEquals(network.urls, [
                "https://api.github.com/repos/gandazgul/runwield/releases",
                "https://raw.githubusercontent.com/gandazgul/runwield/v999.0.0-rc.2/install.sh",
            ]);
            assertEquals(installer.invocations[0].releaseTag, "v999.0.0-rc.2");
            assertEquals(prompts, [
                `RunWield will install from ${VERSION} to v999.0.0-rc.2.\nContinue? [Y/n] `,
            ]);
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update cancels RC installation when user answers no", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = () => "n";
        try {
            const network = createNetworkFixture(
                new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.2", prerelease: true, draft: false }])),
            );
            const installer = createInstallerFixture();
            const output = await captureConsole(() =>
                runUpdateCommand(["--rc"], {
                    networkPort: network.port,
                    installerPort: installer.port,
                    exitPort: createExitFixture().port,
                })
            );

            assertEquals(output.logs, ["RunWield update cancelled."]);
            assertEquals(installer.invocations, []);
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update accepts Enter as Yes for an RC", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = () => "";
        try {
            const network = createNetworkFixture(
                new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.2", prerelease: true, draft: false }])),
            );
            const installer = createInstallerFixture();
            await runUpdateCommand(["--rc"], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            });
            assertEquals(installer.invocations[0].releaseTag, "v999.0.0-rc.2");
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update cancels RC installation when prompt is dismissed", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = () => null;
        try {
            const network = createNetworkFixture(
                new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.2", prerelease: true, draft: false }])),
            );
            const installer = createInstallerFixture();
            const output = await captureConsole(() =>
                runUpdateCommand(["--rc"], {
                    networkPort: network.port,
                    installerPort: installer.port,
                    exitPort: createExitFixture().port,
                })
            );
            assertEquals(output.logs, ["RunWield update cancelled."]);
            assertEquals(installer.invocations, []);
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update installs an exact stable tag without confirmation", async () => {
    const network = createNetworkFixture(makeJsonResponse({ tag_name: "v111.0.0" }));
    const installer = createInstallerFixture();

    await runUpdateCommand(["--to", "v999.1.0"], {
        networkPort: network.port,
        installerPort: installer.port,
        exitPort: createExitFixture().port,
    });

    assertEquals(network.urls, ["https://raw.githubusercontent.com/gandazgul/runwield/v999.1.0/install.sh"]);
    assertEquals(installer.invocations[0].releaseTag, "v999.1.0");
});

Deno.test("update refuses exact downgrade only when the current build version is comparable", async () => {
    await withProcessGlobalTestLock(async () => {
        const installer = createInstallerFixture();
        const exits = createExitFixture();

        const output = await captureConsole(() =>
            runUpdateCommand(["--to", "v0.0.1"], {
                networkPort: createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" })).port,
                installerPort: installer.port,
                exitPort: exits.port,
            })
        );

        if (parseRunWieldReleaseVersion(VERSION)) {
            assertEquals(output.errors, [
                `RunWield update failed: Refusing to downgrade from ${VERSION} to v0.0.1 without --downgrade.`,
            ]);
            assertEquals(installer.invocations, []);
            assertEquals(exits.codes, [1]);
        } else {
            assertEquals(output.errors, []);
            assertEquals(installer.invocations[0].releaseTag, "v0.0.1");
            assertEquals(exits.codes, []);
        }
    });
});

Deno.test("update installs exact downgrade when it is explicit and confirmed", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = () => "INSTALL";
        try {
            const installer = createInstallerFixture();

            await runUpdateCommand(["--to", "v0.0.1", "--downgrade"], {
                networkPort: createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" })).port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            });

            assertEquals(installer.invocations[0].releaseTag, "v0.0.1");
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update skips confirmation when yes is supplied for an RC", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousPrompt = globalThis.prompt;
        globalThis.prompt = () => {
            throw new Error("prompt should not be called");
        };
        try {
            const network = createNetworkFixture(
                new Response(JSON.stringify([{ tag_name: "v999.0.0-rc.2", prerelease: true, draft: false }])),
            );
            const installer = createInstallerFixture();

            await runUpdateCommand(["--rc", "--yes"], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: createExitFixture().port,
            });

            assertEquals(installer.invocations[0].releaseTag, "v999.0.0-rc.2");
        } finally {
            globalThis.prompt = previousPrompt;
        }
    });
});

Deno.test("update cleans its real temp directory before forwarding installer failure", async () => {
    await withProcessGlobalTestLock(async () => {
        const network = createNetworkFixture(makeJsonResponse({ tag_name: "v999.0.0" }));
        const installer = createInstallerFixture(7);
        const exits = createExitFixture();

        await captureConsole(() =>
            runUpdateCommand([], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: exits.port,
            })
        );

        assertEquals(exits.codes, [7]);
        await assertRemoved(dirname(installer.invocations[0].scriptPath));
    });
});

Deno.test("update reports release lookup failures without creating an installer process", async () => {
    await withProcessGlobalTestLock(async () => {
        const network = createNetworkFixture(makeJsonResponse({}, 500));
        const installer = createInstallerFixture();
        const exits = createExitFixture();

        const output = await captureConsole(() =>
            runUpdateCommand([], {
                networkPort: network.port,
                installerPort: installer.port,
                exitPort: exits.port,
            })
        );

        assertEquals(output.errors, ["RunWield update failed: GitHub latest release request failed: 500"]);
        assertEquals(installer.invocations, []);
        assertEquals(exits.codes, [1]);
    });
});

Deno.test("package-managed update prints the package command and does not run the installer", async () => {
    const root = await Deno.makeTempDir({ prefix: "runwield-package-update-" });
    try {
        const libexec = join(root, "Cellar", "wld", "1.2.3", "libexec");
        const bin = join(root, "bin");
        await Deno.mkdir(libexec, { recursive: true });
        await Deno.mkdir(bin, { recursive: true });
        const exe = join(libexec, "wld");
        const link = join(bin, "wld");
        await Deno.copyFile(Deno.execPath(), exe);
        await Deno.chmod(exe, 0o755);
        await Deno.symlink(exe, link);
        await Deno.writeTextFile(
            join(libexec, "runwield-install.json"),
            JSON.stringify({
                schemaVersion: 1,
                packageManager: "homebrew",
                packageIdentifier: "gandazgul/tap/wld",
                updateCommand: "brew upgrade gandazgul/tap/wld",
                repairCommand: "brew reinstall gandazgul/tap/wld",
                installDirectory: libexec,
                version: "v1.2.3",
            }),
        );
        const child = join(root, "assert-update.ts");
        await Deno.writeTextFile(
            child,
            `import { assertEquals, assertStringIncludes } from "@std/assert";\n` +
                `import { runUpdateCommand } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};\n` +
                `const calls = [];\n` +
                `const originalLog = console.log;\n` +
                `const logs = [];\n` +
                `console.log = (message = "") => logs.push(String(message));\n` +
                `await runUpdateCommand(["--rc"], {\n` +
                `  networkPort: { fetch: () => { throw new Error("network should not be used"); } },\n` +
                `  installerPort: { run: async () => { calls.push("installer"); return 0; } },\n` +
                `  exitPort: { exit: (code) => { throw new Error("exit " + code); } },\n` +
                `});\n` +
                `console.log = originalLog;\n` +
                `assertEquals(calls, []);\n` +
                `assertStringIncludes(logs.join("\\n"), "brew upgrade gandazgul/tap/wld");\n` +
                `assertStringIncludes(logs.join("\\n"), "Stable channel");\n`,
        );
        const result = await new Deno.Command(link, {
            args: ["run", "-A", "--config", join(Deno.cwd(), "deno.json"), child],
            stdout: "piped",
            stderr: "piped",
        }).output();
        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        assertEquals(result.code, 0, `${stdout}\n${stderr}`);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
