import process from "node:process";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { readWorkspaceStyles } from "../src/ui/workspace/workspace-styles.ts";
import {
    buildPlanServerRuntime,
    findProhibitedRuntimeFiles,
    listRuntimeAssetDestinations,
    listRuntimeFiles,
    REQUIRED_WORKSPACE_RUNTIME_FILES,
} from "./build-plan-server-runtime.js";

/** @returns {Promise<string>} */
async function makeTempRoot() {
    return await fsMkdtemp(join(tmpdir(), "runwield-plan-server-runtime-"));
}

/**
 * @param {string} path
 * @param {string} content
 */
async function writeFile(path, content = "fixture") {
    await fsMkdir(join(path, ".."), { recursive: true }).catch(() => {});
    await fsWriteFile(path, content);
}

/** @param {string} root */
const AGENT_DEFINITION_ASSETS = [
    "src/agent-definitions/architect.md",
    "src/agent-definitions/engineer.md",
    "src/agent-definitions/guide.md",
    "src/agent-definitions/ideator.md",
    "src/agent-definitions/operator.md",
    "src/agent-definitions/planner.md",
    "src/agent-definitions/recorder.md",
    "src/agent-definitions/router.md",
    "src/agent-definitions/tester.md",
];

/** @param {string} root */
async function writeRuntimeInputs(root) {
    await writeFile(join(root, "src/ui/workspace/remote-server.ts"), "console.log('remote');\n");
    await writeFile(join(root, "dist/workspace-runtime/server.mjs"), "export default {};\n");
    await writeFile(join(root, "dist/workspace-runtime/client/_astro/app.js.asset"), "browser");
    await writeFile(join(root, "brand/logo.svg"), "<svg></svg>\n");
    for (const asset of AGENT_DEFINITION_ASSETS) await writeFile(join(root, asset), "---\nname: test\n---\n");
    await writeFile(join(root, "src/ui/workspace/static/styles.css"), "body{}\n");
    await writeFile(join(root, "src/ui/workspace/static/workspace.css"), ".workspace{}\n");
    await writeFile(join(root, "src/ui/design-system/tokens.css"), ":root{}\n");
    await writeFile(join(root, "src/ui/design-system/components.css"), ".button{}\n");
    await writeFile(join(root, "src/ui/theme/catppuccin-mocha.json"), '{"name":"catppuccin-mocha"}\n');
}

test("listRuntimeAssetDestinations returns the passive asset allowlist", () => {
    assertEquals(listRuntimeAssetDestinations(), [
        "brand/logo.svg",
        ...AGENT_DEFINITION_ASSETS,
        "src/ui/design-system/components.css",
        "src/ui/design-system/tokens.css",
        "src/ui/theme/catppuccin-mocha.json",
        "src/ui/workspace/static/styles.css",
        "src/ui/workspace/static/workspace.css",
    ]);
});

test("buildPlanServerRuntime creates a minimal runtime root", async () => {
    const root = await makeTempRoot();
    try {
        await writeRuntimeInputs(root);
        /** @type {Array<{ command: string, args: string[] }>} */
        const commands = [];
        await buildPlanServerRuntime(
            {
                remoteEntry: join(root, "src/ui/workspace/remote-server.ts"),
                workspaceRuntimeDir: join(root, "dist/workspace-runtime"),
                runtimeDir: join(root, "dist/plan-server"),
            },
            {
                run: async (command, args) => {
                    commands.push({ command, args });
                    const outputIndex = args.indexOf("--outfile");
                    await writeFile(args[outputIndex + 1], "// bundled remote server\n");
                },
            },
        );

        assertEquals(commands, [
            {
                command: process.execPath,
                args: [
                    "build",
                    "--target",
                    "bun",
                    "--minify",
                    "--outfile",
                    join(root, "dist/plan-server/remote-server.js"),
                    join(root, "src/ui/workspace/remote-server.ts"),
                ],
            },
        ]);

        const packagedCss = await fsReadFile(
            join(root, "dist/plan-server/src/ui/workspace/static/workspace.css"),
            "utf8",
        );
        assertEquals(packagedCss, await readWorkspaceStyles("src/ui/workspace/static/workspace.css"));
        assertEquals(packagedCss.includes("@import"), false);

        assertEquals(await listRuntimeFiles(join(root, "dist/plan-server")), [
            "brand/logo.svg",
            "dist/workspace-runtime/client/_astro/app.js.asset",
            "dist/workspace-runtime/server.mjs",
            "remote-server.js",
            ...AGENT_DEFINITION_ASSETS,
            "src/ui/design-system/components.css",
            "src/ui/design-system/tokens.css",
            "src/ui/theme/catppuccin-mocha.json",
            "src/ui/workspace/static/styles.css",
            "src/ui/workspace/static/workspace.css",
        ]);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("buildPlanServerRuntime removes stale output", async () => {
    const root = await makeTempRoot();
    try {
        await writeRuntimeInputs(root);
        await writeFile(join(root, "dist/plan-server/src/cli.ts"), "stale");
        await writeFile(
            join(root, "dist/plan-server/src/agent-definitions/subagent-definitions/reviewer-prompt.md"),
            "stale",
        );
        await buildPlanServerRuntime(
            {
                remoteEntry: join(root, "src/ui/workspace/remote-server.ts"),
                workspaceRuntimeDir: join(root, "dist/workspace-runtime"),
                runtimeDir: join(root, "dist/plan-server"),
            },
            {
                run: async (_command, args) => {
                    await writeFile(args[args.indexOf("--outfile") + 1], "// bundled remote server\n");
                },
            },
        );

        const files = await listRuntimeFiles(join(root, "dist/plan-server"));
        assertEquals(files.includes("src/cli.ts"), false);
        assertEquals(files.includes("src/agent-definitions/subagent-definitions/reviewer-prompt.md"), false);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("buildPlanServerRuntime fails when required inputs are missing", async () => {
    const root = await makeTempRoot();
    try {
        await assertRejects(
            () =>
                buildPlanServerRuntime(
                    {
                        remoteEntry: join(root, "src/ui/workspace/remote-server.ts"),
                        workspaceRuntimeDir: join(root, "dist/workspace-runtime"),
                        runtimeDir: join(root, "dist/plan-server"),
                    },
                    {
                        run: async () => {},
                    },
                ),
            Error,
            "Required Plan Server runtime file is missing",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("buildPlanServerRuntime fails clearly when Workspace runtime output lacks server entry", async () => {
    const root = await makeTempRoot();
    try {
        await writeRuntimeInputs(root);
        await fsRm(join(root, "dist/workspace-runtime/server.mjs"));
        let didRunBundle = false;

        await assertRejects(
            () =>
                buildPlanServerRuntime(
                    {
                        remoteEntry: join(root, "src/ui/workspace/remote-server.ts"),
                        workspaceRuntimeDir: join(root, "dist/workspace-runtime"),
                        runtimeDir: join(root, "dist/plan-server"),
                    },
                    {
                        run: () => {
                            didRunBundle = true;
                            return Promise.resolve();
                        },
                    },
                ),
            Error,
            `Required Plan Server runtime file is missing: ${join(root, "dist/workspace-runtime/server.mjs")}`,
        );
        assertEquals(didRunBundle, false);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("required Workspace runtime file list includes the Astro server entry", () => {
    assertEquals(REQUIRED_WORKSPACE_RUNTIME_FILES, ["server.mjs"]);
});

test("findProhibitedRuntimeFiles rejects broad source and state copies", () => {
    assertEquals(
        findProhibitedRuntimeFiles([
            "remote-server.js",
            "dist/workspace-runtime/server.mjs",
            "src/ui/workspace/static/styles.css",
            "src/ui/workspace/server.js",
            "docs/plans/example.md",
            ".wld/collaboration-secrets.json",
            "data/runwield.sqlite",
            ".git/config",
            "src/ui/workspace/workspace.test.js",
        ]),
        [
            "src/ui/workspace/server.js",
            "docs/plans/example.md",
            ".wld/collaboration-secrets.json",
            "data/runwield.sqlite",
            ".git/config",
            "src/ui/workspace/workspace.test.js",
        ],
    );
});
