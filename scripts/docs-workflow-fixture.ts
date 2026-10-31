/** Real Git and host-boundary fixtures shared by documentation workflow checks. */
import { bashFixtureExecutable, bashFixturePath, quoteBashFixture } from "./bash-fixture.ts";
import { delimiter, dirname, join, resolve } from "node:path";
import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import { getCwd } from "../src/constants.js";
import {
    chmod as fsChmod,
    cp as fsCp,
    symlink as fsSymlink,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { defineGitFixture, git } from "../src/shared/git-test-fixture.ts";
import { PUBLIC_DOCS } from "./public-docs.ts";
import { releaseAssetNames } from "./release-assets.ts";
import { sha256File } from "./build-metadata.ts";

export function jobBlock(workflow: string, name: string): string {
    const start = workflow.indexOf(`    ${name}:`);
    if (start < 0) throw new Error(`Missing job ${name}`);
    const remainder = workflow.slice(start + 1);
    const nextJob = remainder.match(/^ {4}[a-z][\w-]*:\s*$/m);
    const end = nextJob?.index === undefined ? undefined : start + 1 + nextJob.index;
    return workflow.slice(start, end);
}

export function jobCondition(job: string): string {
    const match = job.match(/(?:^|\n)\s+if:\s*(?:\$\{\{\s*)?(.*?)(?:\s*\}\})?\s*$/m);
    if (!match) throw new Error("Job has no condition");
    return match[1];
}

export function stepBlock(job: string, name: string): string {
    const marker = `            - name: ${name}\n`;
    const start = job.indexOf(marker);
    if (start < 0) throw new Error(`Missing step ${name}`);
    const block = job.slice(start + marker.length);
    const next = block.search(/^ {12}- /m);
    return next < 0 ? block : block.slice(0, next);
}

export function stepRun(job: string, name: string): string {
    const run = stepBlock(job, name).match(/^ {14}run:[ \t]*\|\n((?:(?: {18}[^\n]*|[ \t]*)\n?)*)/m);
    if (!run) throw new Error(`Step ${name} has no multiline command`);
    return run[1]
        .split("\n")
        .map((line) => line.slice(18))
        .join("\n")
        .trim();
}

export async function executable(path: string, content: string): Promise<void> {
    await fsWriteFile(path, content);
    await fsChmod(path, 0o755);
}

export async function runShell(
    command: string,
    env: Record<string, string>,
    cwd = getCwd(),
): Promise<import("./script-process.ts").ScriptProcessOutput> {
    // Git Bash prepends its own Git directory; restore the explicit boundary fixtures first.
    const path = (env.PATH || process.env.PATH || "").split(delimiter).map(bashFixturePath).join(":");
    return await captureScriptProcess(bashFixtureExecutable(), {
        args: ["-c", `export PATH=${quoteBashFixture(path)}; ${command}`],
        cwd,
        env,
        clearEnv: false,
        stdout: "piped",
        stderr: "piped",
    });
}

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const tag = "v2.0.0";
export const decoder = new TextDecoder();

export async function write(path: string, content: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, content);
}

// Historical content has no usable build script or Bun pin. Deployment must use
// the separate frozen tooling checkout, not execute the historical toolchain.
const sourceFixture = defineGitFixture(async (work) => {
    for (const path of PUBLIC_DOCS) {
        await write(join(work, "docs", path), `# ${path}\n\nCORRECTED-MANUAL\n`);
    }
    await write(
        join(work, "docs/user-documentation/index.md"),
        "# RunWield Documentation\n\nQuickstart. Configure RunWield.\n",
    );
    await fsCp(join(repositoryRoot, "docs-site"), join(work, "docs-site"), {
        recursive: true,
        filter: (path) => !["node_modules", ".astro", "content", "dist"].includes(path.split(/[\\/]/).pop() || ""),
    });
    await write(
        join(work, "docs-site/release.json"),
        JSON.stringify({
            version: tag,
            sourceRef: "main",
            releaseUrl: `https://example.test/${tag}`,
        }),
    );
    await write(join(work, "scripts/build-stable-docs.ts"), 'throw new Error("Historical tooling must not run");\n');
    await write(join(work, "deno.lock"), "{}\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-m", "Historical Stable source"]);
    await git(work, ["tag", tag]);
});

export async function docsFixture() {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-docs-workflow-"));
    const source = join(root, "source");
    const checkout = await sourceFixture.checkout();
    try {
        await fsCp(checkout, source, { recursive: true });
    } finally {
        await fsRm(checkout, { recursive: true, force: true });
    }
    const remote = join(root, "origin.git");
    await git(root, ["clone", "--bare", source, remote]);
    await git(source, ["remote", "add", "origin", remote]);
    const releaseSha = await git(source, ["rev-parse", tag]);
    await write(
        join(source, "docs-site/release.json"),
        JSON.stringify({
            version: tag,
            sourceRef: releaseSha,
            releaseUrl: `https://example.test/${tag}`,
        }),
    );
    await git(source, ["add", "docs-site/release.json"]);
    await git(source, ["commit", "-m", "Document Stable"]);
    await git(source, ["push", "origin", "HEAD:refs/heads/docs/stable"]);
    const sha = await git(source, ["rev-parse", "HEAD"]);
    await fsSymlink(repositoryRoot, join(root, "tooling"), "junction");
    const bin = join(root, "bin");
    await fsMkdir(bin);
    await executable(
        join(bin, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${GH_MODE:-}" == api-error ]]; then echo "API unavailable" >&2; exit 41; fi
case "$1 $2" in
  "release view")
    if [[ "$*" == *tagName* ]]; then echo "$LATEST_TAG"; else echo '{}'; fi ;;
  "release download")
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --dir ]]; then
        mkdir -p "$2"
        if [[ "\${GH_MODE:-}" == incomplete ]]; then echo partial > "$2/partial";
        else cp -R "$PUBLISHED_DIR/." "$2/"; fi
        exit 0
      fi
      shift
    done
    exit 2 ;;
  api*) cat "$PUBLISHED_METADATA" ;;
  *) echo "Unexpected gh arguments: $*" >&2; exit 99 ;;
esac
`,
    );
    const env = {
        PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
        GITHUB_REF: "refs/heads/docs/stable",
        GITHUB_REPOSITORY: "owner/repository",
        REQUESTED_TAG: tag,
        LATEST_TAG: tag,
        GITHUB_OUTPUT: join(root, "output"),
        RUNNER_TEMP: root,
        PUBLISHED_DIR: join(root, "published"),
        PUBLISHED_METADATA: join(root, "published.json"),
        EVENT_NAME: "workflow_dispatch",
    };
    return { root, source, remote, sha, releaseSha, env };
}

type DocsFixture = Awaited<ReturnType<typeof docsFixture>>;

interface PublishedAsset {
    name: string;
    digest: string;
}

export interface PublishedRelease {
    assets: PublishedAsset[];
}

export async function publishedAssets(f: DocsFixture, recorded = f.sha, legacy = false): Promise<void> {
    await fsMkdir(f.env.PUBLISHED_DIR);
    const stage = join(f.root, "archive");
    await fsMkdir(stage);
    await write(join(stage, "release.json"), JSON.stringify({ version: tag, sourceRef: recorded }));
    await write(join(stage, "index.html"), "QUALIFIED-ARCHIVE-BYTES\n");
    const names = releaseAssetNames(tag).filter((name) => !legacy || !name.startsWith("runwield-docs-"));
    for (const name of names.filter((name) => !name.endsWith(".sha256") && name !== "SHA256SUMS")) {
        const path = join(f.env.PUBLISHED_DIR, name);
        if (name.startsWith("runwield-docs-")) {
            const result = await captureScriptProcess("tar", { args: ["-czf", path, "-C", stage, "."] });
            assert(result.success, decoder.decode(result.stderr));
        } else await fsWriteFile(path, name);
        if (names.includes(`${name}.sha256`)) {
            await fsWriteFile(`${path}.sha256`, `${await sha256File(path)}  ${name}\n`);
        }
    }
    const sums = await Promise.all(
        names
            .filter((name) => name.endsWith(".sha256"))
            .map((name) => fsReadFile(join(f.env.PUBLISHED_DIR, name), "utf8")),
    );
    await fsWriteFile(join(f.env.PUBLISHED_DIR, "SHA256SUMS"), sums.join(""));
    const assets = await Promise.all(
        names.map(async (name) => ({
            name,
            digest: `sha256:${await sha256File(join(f.env.PUBLISHED_DIR, name))}`,
        })),
    );
    await fsWriteFile(f.env.PUBLISHED_METADATA, JSON.stringify({ assets }));
}

export async function docsStep(name: string): Promise<string> {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/docs.yml"), "utf8");
    return stepRun(jobBlock(workflow, "deploy"), name);
}
