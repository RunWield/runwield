import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { PUBLIC_DOCS, renderPublicDocument, stagePublicDocs } from "./public-docs.ts";

const RELEASE = {
    version: "v1.2.3",
    sourceRef: "0123456789abcdef",
    releaseUrl: "https://github.com/gandazgul/runwield/releases/tag/v1.2.3",
};

Deno.test("public docs render their source heading and release-pinned links", () => {
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
    assertStringIncludes(
        rendered,
        "/docs-assets/brand/logo.svg",
    );
    assertEquals(rendered.includes("# Example"), false);
});

Deno.test("public docs reject source without a page title", () => {
    assertRejects(
        async () =>
            await Promise.resolve(
                renderPublicDocument("No heading", "user-documentation/quickstart.md", RELEASE),
            ),
        Error,
        "needs one H1",
    );
});

Deno.test("public docs stage only the publication manifest", async () => {
    const root = await Deno.makeTempDir();
    try {
        await Deno.mkdir(`${root}/docs-site`, { recursive: true });
        await Deno.mkdir(`${root}/docs`, { recursive: true });
        await Deno.writeTextFile(
            `${root}/docs-site/release.json`,
            JSON.stringify(RELEASE),
        );
        for (const path of PUBLIC_DOCS) {
            await Deno.mkdir(dirname(`${root}/docs/${path}`), { recursive: true });
            await Deno.writeTextFile(`${root}/docs/${path}`, `# ${path}\n\nMARKER-${path}\n`);
        }
        await Deno.mkdir(`${root}/brand`);
        await Deno.writeTextFile(`${root}/brand/logo.svg`, "<svg></svg>");
        await Deno.writeTextFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\nMARKER-quickstart\n\n![Logo](../../brand/logo.svg)\n",
        );
        await Deno.writeTextFile(
            `${root}/docs/prd/secret.md`,
            "# INTERNAL-PRD-MARKER\n",
        );
        const output = `${root}/generated`;
        await stagePublicDocs(root, output);
        const paths = Array.from(Deno.readDirSync(output)).map((entry) => entry.name).sort();
        assertEquals(paths.includes("prd"), false);
        assertEquals(paths.includes("index.md"), true);
        assertEquals(paths.includes("contributing"), true);
        assertEquals(paths.includes("user-documentation"), false);
        assertStringIncludes(
            await Deno.readTextFile(`${output}/contributing/prd/runwield-core-prd.md`),
            "MARKER-prd/runwield-core-prd.md",
        );
        assertStringIncludes(
            await Deno.readTextFile(`${output}/quickstart.md`),
            "MARKER-quickstart",
        );
        assertEquals(
            await Deno.readTextFile(`${root}/docs-site/public/docs-assets/brand/logo.svg`),
            "<svg></svg>",
        );
        await Deno.writeTextFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\n[missing](does-not-exist.md)\n",
        );
        await assertRejects(
            () => stagePublicDocs(root, output),
            Error,
            "missing local target",
        );
        await Deno.writeTextFile(
            `${root}/docs/user-documentation/quickstart.md`,
            "# quickstart\n\n[Broken section](#missing-section)\n",
        );
        await assertRejects(
            () => stagePublicDocs(root, output),
            Error,
            "missing fragment",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

async function copyTree(source: string, destination: string): Promise<void> {
    await Deno.mkdir(destination, { recursive: true });
    for await (const entry of Deno.readDir(source)) {
        if (entry.name === "content" || entry.name === "docs-assets") continue;
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory) await copyTree(from, to);
        else if (entry.isFile) await Deno.copyFile(from, to);
    }
}

async function assertNonEmptyTree(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
        const path = join(directory, entry.name);
        if (entry.isDirectory) await assertNonEmptyTree(path);
        else assert((await Deno.stat(path)).size > 0, `Empty search output: ${path}`);
    }
}

Deno.test("production docs build publishes and indexes only fixture manual pages", async () => {
    const root = await Deno.makeTempDir();
    const repositoryRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
    try {
        await copyTree(join(repositoryRoot, "docs-site", "src"), join(root, "docs-site", "src"));
        await copyTree(join(repositoryRoot, "docs-site", "public"), join(root, "docs-site", "public"));
        for (const name of ["astro.config.mjs", "deno.json", "package.json", "release.json", "tsconfig.json"]) {
            await Deno.copyFile(join(repositoryRoot, "docs-site", name), join(root, "docs-site", name));
        }
        await Deno.mkdir(join(root, "docs"), { recursive: true });
        for (const path of PUBLIC_DOCS) {
            await Deno.mkdir(dirname(join(root, "docs", path)), { recursive: true });
            await Deno.writeTextFile(join(root, "docs", path), `# ${path}\n\nFIXTURE-${path}\n`);
        }
        await Deno.writeTextFile(
            join(root, "docs", "user-documentation", "index.md"),
            "# RunWield Documentation\n\nFIXTURE-PUBLIC-PHRASE\n\n## Start\n\n[Quickstart](quickstart.md#working-section)\n\n## Configure RunWield\n",
        );
        await Deno.writeTextFile(
            join(root, "docs", "user-documentation", "quickstart.md"),
            "# Quickstart\n\n## Working section\n\n`FIXTURE-GUIDE-CODE`\n\n[Start][home]\n\n[Internal](../prd/secret.md#private)\n\n![Logo](../../brand/logo.svg)\n\n[home]: index.md#start\n",
        );
        await Deno.writeTextFile(join(root, "docs", "prd", "secret.md"), "# Private\n\nEXCLUDED-SEARCH-MARKER\n");
        await Deno.mkdir(join(root, "docs", "plans"), { recursive: true });
        await Deno.writeTextFile(join(root, "docs", "plans", "plan.md"), "# Plan\n\nEXCLUDED-PLAN-MARKER\n");
        await Deno.mkdir(join(root, "docs", "research"), { recursive: true });
        await Deno.writeTextFile(join(root, "docs", "research", "note.md"), "# Research\n\nEXCLUDED-RESEARCH-MARKER\n");
        await Deno.mkdir(join(root, "brand"), { recursive: true });
        await Deno.writeTextFile(join(root, "brand", "logo.svg"), "<svg>FIXTURE-LOGO</svg>");
        await Deno.writeTextFile(join(root, "unrelated-media.txt"), "EXCLUDED-MEDIA-MARKER");

        await stagePublicDocs(root, join(root, "docs-site", "src", "content", "docs"));
        const build = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", "npm:astro@7.3.3", "build"],
            cwd: join(root, "docs-site"),
            stdout: "piped",
            stderr: "piped",
        }).output();
        assert(build.success, new TextDecoder().decode(build.stderr));

        const output = join(root, "dist", "docs");
        const index = await Deno.readTextFile(join(output, "index.html"));
        const quickstart = await Deno.readTextFile(join(output, "quickstart", "index.html"));
        assertStringIncludes(index, "FIXTURE-PUBLIC-PHRASE");
        assertStringIncludes(index, "<site-search");
        assertStringIncludes(quickstart, "FIXTURE-GUIDE-CODE");
        assertStringIncludes(
            quickstart,
            'href="https://github.com/gandazgul/runwield/blob/main/docs/prd/secret.md#private"',
        );
        assertStringIncludes(quickstart, 'src="/docs-assets/brand/logo.svg"');
        assertEquals(
            await Deno.readTextFile(join(output, "docs-assets", "brand", "logo.svg")),
            "<svg>FIXTURE-LOGO</svg>",
        );
        const sitemap = await Deno.readTextFile(join(output, "sitemap-0.xml"));
        assertEquals(sitemap.includes("docs.runwield.dev/prd/"), false);
        assertEquals(sitemap.includes("/plans/"), false);
        const pagefind = JSON.parse(await Deno.readTextFile(join(output, "pagefind", "pagefind-entry.json")));
        assertEquals(pagefind.languages.en.page_count, PUBLIC_DOCS.length);
        await assertNonEmptyTree(join(output, "pagefind"));
        assertEquals(index.includes("EXCLUDED-SEARCH-MARKER"), false);
        await assertRejects(() => Deno.stat(join(output, "prd", "secret", "index.html")), Deno.errors.NotFound);

        await Deno.writeTextFile(
            join(output, "quickstart", "index.html"),
            `${quickstart}<a href="#missing-built-fragment">Broken</a>`,
        );
        const check = await new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", join(repositoryRoot, "scripts", "check-public-docs.ts")],
            cwd: root,
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(check.success, false);
        assertStringIncludes(new TextDecoder().decode(check.stderr), "missing fragment #missing-built-fragment");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
