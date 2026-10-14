import { prepareDocsDependencies } from "./docs-dependencies.ts";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";
import { captureScriptProcess } from "./script-process.ts";
import { readdirSync as fsReaddirSync } from "node:fs";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { PUBLIC_DOCS, renderPublicDocument, stagePublicDocs } from "./public-docs.ts";

const RELEASE = {
    version: "v1.2.3",
    sourceRef: "0123456789abcdef",
    releaseUrl: "https://github.com/gandazgul/runwield/releases/tag/v1.2.3",
};

test("public docs render their source heading and release-pinned links", () => {
    const rendered = renderPublicDocument(
        "# Example\n\nRead [usage](usage.md#commands), [the PRD](../prd/runwield.md), [a plan](../plans/x.md), [reference guide][guide], and [Pi](https://pi.dev).\n\n![Logo](../../brand/logo.svg)\n\n[guide]: usage.md#commands\n",
        "user-documentation/quickstart.md",
        RELEASE,
    );
    assertStringIncludes(rendered, 'title: "Example"');
    assertStringIncludes(rendered, "[usage](/usage/#commands)");
    assertStringIncludes(rendered, "[guide]: /usage/#commands");
    assertStringIncludes(rendered, "[the PRD](/contributing/prd/runwield/)");
    assertStringIncludes(rendered, "/blob/0123456789abcdef/docs/plans/x.md");
    assertStringIncludes(
        rendered,
        'editUrl: "https://github.com/gandazgul/runwield/edit/docs/stable/docs/user-documentation/quickstart.md"',
    );
    assertStringIncludes(rendered, "[Pi](https://pi.dev)");
    assertStringIncludes(rendered, "/docs-assets/brand/logo.svg");
    assertEquals(rendered.includes("# Example"), false);
});

test("public docs reject source without a page title", () => {
    assertRejects(
        async () =>
            await Promise.resolve(renderPublicDocument("No heading", "user-documentation/quickstart.md", RELEASE)),
        Error,
        "needs one H1",
    );
});

test("public docs stage only the publication manifest", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        await fsMkdir(`${root}/docs-site`, { recursive: true });
        await fsMkdir(`${root}/docs`, { recursive: true });
        await fsWriteFile(`${root}/docs-site/release.json`, JSON.stringify(RELEASE));
        for (const path of PUBLIC_DOCS) {
            await fsMkdir(dirname(`${root}/docs/${path}`), { recursive: true });
            await fsWriteFile(`${root}/docs/${path}`, `# ${path}\n\nMARKER-${path}\n`);
        }
        await fsMkdir(`${root}/brand`);
        await fsWriteFile(`${root}/brand/logo.svg`, "<svg></svg>");
        await fsWriteFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\nMARKER-quickstart\n\n![Logo](../../brand/logo.svg)\n",
        );
        await fsWriteFile(`${root}/docs/prd/secret.md`, "# INTERNAL-PRD-MARKER\n");
        const output = `${root}/generated`;
        await stagePublicDocs(root, output);
        const paths = Array.from(fsReaddirSync(output, { withFileTypes: true }))
            .map((entry) => entry.name)
            .sort();
        assertEquals(paths.includes("prd"), false);
        assertEquals(paths.includes("index.md"), true);
        assertEquals(paths.includes("contributing"), true);
        assertEquals(paths.includes("user-documentation"), false);
        assertStringIncludes(
            await fsReadFile(`${output}/contributing/prd/runwield-core-prd.md`, "utf8"),
            "MARKER-prd/runwield-core-prd.md",
        );
        assertStringIncludes(await fsReadFile(`${output}/quickstart.md`, "utf8"), "MARKER-quickstart");
        assertEquals(await fsReadFile(`${root}/docs-site/public/docs-assets/brand/logo.svg`, "utf8"), "<svg></svg>");
        await fsWriteFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\n[missing](does-not-exist.md)\n",
        );
        await assertRejects(() => stagePublicDocs(root, output), Error, "missing local target");
        await fsWriteFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\n[Broken section](#missing-section)\n",
        );
        await assertRejects(() => stagePublicDocs(root, output), Error, "missing fragment");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

async function copyTree(source: string, destination: string): Promise<void> {
    await fsMkdir(destination, { recursive: true });
    for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
        if (entry.name === "content" || entry.name === "docs-assets") continue;
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory()) await copyTree(from, to);
        else if (entry.isFile()) await fsCopyFile(from, to);
    }
}

async function assertNonEmptyTree(directory: string): Promise<void> {
    for await (const entry of await fsReaddir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await assertNonEmptyTree(path);
        else assert((await fsStat(path)).size > 0, `Empty search output: ${path}`);
    }
}

test("production docs build publishes and indexes only fixture manual pages", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const repositoryRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
    try {
        await copyTree(join(repositoryRoot, "docs-site", "src"), join(root, "docs-site", "src"));
        await copyTree(join(repositoryRoot, "docs-site", "public"), join(root, "docs-site", "public"));
        for (const name of ["astro.config.mjs", "package.json", "release.json", "tsconfig.json"]) {
            await fsCopyFile(join(repositoryRoot, "docs-site", name), join(root, "docs-site", name));
        }
        await fsMkdir(join(root, "docs"), { recursive: true });
        for (const path of PUBLIC_DOCS) {
            await fsMkdir(dirname(join(root, "docs", path)), { recursive: true });
            await fsWriteFile(join(root, "docs", path), `# ${path}\n\nFIXTURE-${path}\n`);
        }
        await fsWriteFile(
            join(root, "docs", "user-documentation", "index.md"),
            "# RunWield Documentation\n\nFIXTURE-PUBLIC-PHRASE\n\n## Start\n\n[Quickstart](quickstart.md#working-section)\n\n## Configure RunWield\n",
        );
        await fsWriteFile(
            join(root, "docs", "user-documentation", "quickstart.md"),
            "# Quickstart\n\n## Working section\n\n`FIXTURE-GUIDE-CODE`\n\n[Start][home]\n\n[Internal](../prd/secret.md#private)\n\n![Logo](../../brand/logo.svg)\n\n[home]: index.md#start\n",
        );
        await fsWriteFile(join(root, "docs", "prd", "secret.md"), "# Private\n\nEXCLUDED-SEARCH-MARKER\n");
        await fsMkdir(join(root, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(root, "docs", "plans", "plan.md"), "# Plan\n\nEXCLUDED-PLAN-MARKER\n");
        await fsMkdir(join(root, "docs", "research"), { recursive: true });
        await fsWriteFile(join(root, "docs", "research", "note.md"), "# Research\n\nEXCLUDED-RESEARCH-MARKER\n");
        await fsMkdir(join(root, "brand"), { recursive: true });
        await fsWriteFile(join(root, "brand", "logo.svg"), "<svg>FIXTURE-LOGO</svg>");
        await fsWriteFile(join(root, "unrelated-media.txt"), "EXCLUDED-MEDIA-MARKER");

        await stagePublicDocs(root, join(root, "docs-site", "src", "content", "docs"));
        await prepareDocsDependencies(root);
        const build = await captureScriptProcess(process.execPath, {
            args: [join(root, "docs-site", "node_modules", "astro", "bin", "astro.mjs"), "build"],
            cwd: join(root, "docs-site"),
            stdout: "piped",
            stderr: "piped",
        });
        assert(build.success, new TextDecoder().decode(build.stderr));

        const output = join(root, "dist", "docs");
        const index = await fsReadFile(join(output, "index.html"), "utf8");
        const quickstart = await fsReadFile(join(output, "quickstart", "index.html"), "utf8");
        assertStringIncludes(index, "FIXTURE-PUBLIC-PHRASE");
        assertStringIncludes(index, "<site-search");
        assertStringIncludes(quickstart, "FIXTURE-GUIDE-CODE");
        assertStringIncludes(
            quickstart,
            'href="https://github.com/gandazgul/runwield/blob/main/docs/prd/secret.md#private"',
        );
        assertStringIncludes(quickstart, 'src="/docs-assets/brand/logo.svg"');
        assertEquals(
            await fsReadFile(join(output, "docs-assets", "brand", "logo.svg"), "utf8"),
            "<svg>FIXTURE-LOGO</svg>",
        );
        const sitemap = await fsReadFile(join(output, "sitemap-0.xml"), "utf8");
        assertEquals(sitemap.includes("docs.runwield.dev/prd/"), false);
        assertEquals(sitemap.includes("/plans/"), false);
        const pagefind = JSON.parse(await fsReadFile(join(output, "pagefind", "pagefind-entry.json"), "utf8"));
        assertEquals(pagefind.languages.en.page_count, PUBLIC_DOCS.length);
        await assertNonEmptyTree(join(output, "pagefind"));
        assertEquals(index.includes("EXCLUDED-SEARCH-MARKER"), false);
        const absent = await assertRejects(() => fsStat(join(output, "prd", "secret", "index.html")), Error);
        assertEquals(Reflect.get(absent, "code"), "ENOENT");

        await fsWriteFile(
            join(output, "quickstart", "index.html"),
            `${quickstart}<a href="#missing-built-fragment">Broken</a>`,
        );
        const check = await captureScriptProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", join(repositoryRoot, "scripts", "check-public-docs.ts")]),
            cwd: root,
            stdout: "piped",
            stderr: "piped",
        });
        assertEquals(check.success, false);
        assertStringIncludes(new TextDecoder().decode(check.stderr), "missing fragment #missing-built-fragment");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
