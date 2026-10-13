import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readlink as fsReadlink,
    realpath as fsRealpath,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * @module ui/tui/testing/isolated-environment
 * Isolated filesystem fixture setup for Golden TUI scenarios.
 */

import { join } from "node:path";
import { git } from "../../../shared/git-test-fixture.ts";
import {
    assertWorkflowBinaryCallsSupported,
    writeWorkflowBinaryFixtures,
} from "../../../testing/workflow-binary-fixtures.ts";
import { RUNWIELD_GITIGNORE_BLOCK } from "../../../shared/runwield-owned-paths.ts";

export const GOLDEN_FAUX_PROVIDER = "golden";
export const GOLDEN_FAUX_MODEL = "faux";
export const GOLDEN_FAUX_API = "golden-faux";

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @typedef {{ id: string, name?: string, reasoning?: boolean }} GoldenModelDefinition */

/**
 * @param {string} runwieldDir
 * @param {{ api?: string, models?: GoldenModelDefinition[] }} [options]
 */
export async function writeGoldenModelConfig(runwieldDir, options = {}) {
    const models = options.models || [{ id: GOLDEN_FAUX_MODEL, name: "Golden Faux Model" }];
    await fsMkdir(runwieldDir, { recursive: true });
    await fsWriteFile(
        join(runwieldDir, "models.json"),
        JSON.stringify(
            {
                providers: {
                    [GOLDEN_FAUX_PROVIDER]: {
                        name: "Golden Faux Provider",
                        baseUrl: "http://127.0.0.1:0",
                        apiKey: "golden-test-key",
                        api: options.api || GOLDEN_FAUX_API,
                        models: models.map((model) => ({
                            id: model.id,
                            name: model.name || model.id,
                            api: options.api || GOLDEN_FAUX_API,
                            reasoning: model.reasoning || false,
                            input: ["text", "image"],
                            contextWindow: 128000,
                            maxTokens: 4096,
                        })),
                    },
                },
            },
            null,
            2,
        ),
    );
}

/** @param {number} ms */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} path */
async function removeTempDir(path) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fsRm(path, { recursive: true });
            return;
        } catch (error) {
            if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return;
            if (attempt === 4) throw error;
            await delay(20 * (attempt + 1));
        }
    }
}

/**
 * @typedef {Object} GoldenIsolatedEnvironment
 * @property {string} root
 * @property {string} home
 * @property {string} projectRoot
 * @property {string} remoteRoot
 * @property {string} runwieldDir
 * @property {Record<string, string>} env
 * @property {() => Promise<void>} cleanup
 */

/** @param {string} root @param {boolean} initArtifact */
async function createGoldenRepository(root, initArtifact) {
    const projectRoot = join(root, "project");
    const remoteRoot = join(root, "remote.git");
    await fsMkdir(projectRoot, { recursive: true });
    await fsWriteFile(
        join(projectRoot, "README.md"),
        "# Golden TUI Fixture\n\nRouting uses the Router to select Guide.\n",
    );
    await fsWriteFile(join(projectRoot, ".gitignore"), RUNWIELD_GITIGNORE_BLOCK);
    if (initArtifact) {
        await fsMkdir(join(projectRoot, "docs"), { recursive: true });
        await fsWriteFile(
            join(projectRoot, "docs", "domain-language.md"),
            "# Domain Language\n\n## Golden Fixture\n\nCurrent Golden project terminology.\n",
        );
    }
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "golden@example.test"]);
    await git(projectRoot, ["config", "user.name", "Golden TUI"]);
    await git(projectRoot, ["config", "commit.gpgsign", "false"]);
    await git(projectRoot, ["add", "-A"]);
    await git(projectRoot, ["commit", "-m", "Initial fixture"]);
    await git(root, ["init", "--bare", remoteRoot]);
    await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
    await git(projectRoot, ["push", "-u", "origin", "main"]);
}

/** @param {string} source @param {string} destination */
async function copyFixtureTree(source, destination) {
    await fsMkdir(destination, { recursive: true });
    for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory()) await copyFixtureTree(from, to);
        else if (entry.isSymbolicLink()) await fsSymlink(await fsReadlink(from), to);
        else await fsCopyFile(from, to);
    }
}

/**
 * Build immutable Git baselines once per suite. Workers copy both repositories;
 * they never share mutable refs, index files, worktrees, or the remote.
 * @param {string} root
 */
export async function prepareGoldenRepositoryTemplates(root) {
    await Promise.all([true, false].map(async (initialized) => {
        const path = join(root, initialized ? "initialized" : "uninitialized");
        await fsMkdir(path, { recursive: true });
        await createGoldenRepository(path, initialized);
    }));
}

/**
 * @typedef {Object} GoldenEnvironmentOptions
 * @property {boolean} [keep]
 * @property {boolean} [initDone]
 * @property {boolean} [initArtifact]
 * @property {string} [repositoryTemplateRoot]
 */

/**
 * @param {GoldenEnvironmentOptions} [options]
 * @returns {Promise<GoldenIsolatedEnvironment>}
 */
export async function createGoldenIsolatedEnvironment(options = {}) {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-golden-tui-"));
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const remoteRoot = join(root, "remote.git");
    const runwieldDir = join(home, ".wld");
    const fixtureBinDir = await writeWorkflowBinaryFixtures(root, { githubUnavailable: true });
    await fsMkdir(runwieldDir, { recursive: true });
    const initDone = options.initDone !== false;
    const initArtifact = options.initArtifact ?? initDone;
    const templateRoot = options.repositoryTemplateRoot || process.env["WLD_GOLDEN_FIXTURE_ROOT"];
    if (templateRoot) {
        const template = join(templateRoot, initArtifact ? "initialized" : "uninitialized");
        await Promise.all([
            copyFixtureTree(join(template, "project"), projectRoot),
            copyFixtureTree(join(template, "remote.git"), remoteRoot),
        ]);
        await git(projectRoot, ["remote", "set-url", "origin", remoteRoot]);
    } else {
        await createGoldenRepository(root, initArtifact);
    }
    await writeGoldenModelConfig(runwieldDir);
    const canonicalProjectRoot = await fsRealpath(projectRoot);
    const projectHash = await sha256(canonicalProjectRoot);
    await fsWriteFile(
        join(runwieldDir, "init-state.json"),
        JSON.stringify(
            {
                [projectHash]: {
                    path: canonicalProjectRoot,
                    initOffered: initDone,
                    initDone,
                    offeredAt: initDone ? new Date(0).toISOString() : null,
                    doneAt: initDone ? new Date(0).toISOString() : null,
                    snipMissingWarningCount: 3,
                    snipMissingWarningLastShownAt: new Date(0).toISOString(),
                },
            },
            null,
            2,
        ) + "\n",
    );
    await fsMkdir(join(runwieldDir, "sessions"), { recursive: true });
    await fsMkdir(join(runwieldDir, "worktrees"), { recursive: true });
    await fsMkdir(join(runwieldDir, "registry"), { recursive: true });
    await fsWriteFile(
        join(runwieldDir, "settings.json"),
        JSON.stringify({
            theme: "default",
            defaultProvider: GOLDEN_FAUX_PROVIDER,
            defaultModel: GOLDEN_FAUX_MODEL,
            // Composed scenarios drive the production TUI composition, whose Runtime
            // adapter wires the real notifier. Without this the suite fires actual
            // desktop notifications on the developer's machine.
            notifications: { enabled: false },
        }),
    );
    const env = {
        HOME: home,
        RUNWIELD_HOME: runwieldDir,
        PATH: `${fixtureBinDir}${delimiter}${process.env["PATH"] || ""}`,
        NO_COLOR: "1",
        TERM: "screen",
        WLD_GOLDEN_TUI: "1",
    };
    return {
        root,
        home,
        projectRoot,
        remoteRoot,
        runwieldDir,
        env,
        async cleanup() {
            try {
                await assertWorkflowBinaryCallsSupported(root);
            } finally {
                if (!options.keep) await removeTempDir(root);
            }
        },
    };
}
