import { assertEquals } from "../src/testing/assertions.ts";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { findBrokenLinks } from "./check-doc-links.ts";

async function documentRepo(t: TestContext, files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "wld-doc-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), contents);
    }
    return {
        readTextFile: (path: string) => readFile(join(root, path), "utf8"),
        pathExists: (path: string) =>
            stat(join(root, path)).then(
                () => true,
                () => false,
            ),
    };
}

test("findBrokenLinks resolves relative to the linking file, not the repo root", async (t) => {
    // The exact defect this ratchet exists for: docs/architecture.md linking
    // "docs/entity-model.md" resolves to docs/docs/entity-model.md.
    const repo = await documentRepo(t, {
        "docs/architecture.md": "[model](docs/entity-model.md)",
        "docs/entity-model.md": "# Model",
    });
    const broken = await findBrokenLinks(["docs/architecture.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, "no such file: docs/docs/entity-model.md");
});

test("findBrokenLinks accepts a correctly resolved sibling link", async (t) => {
    const repo = await documentRepo(t, {
        "docs/architecture.md": "[model](entity-model.md)",
        "docs/entity-model.md": "# Model",
    });
    assertEquals(await findBrokenLinks(["docs/architecture.md"], repo.readTextFile, repo.pathExists), []);
});

test("findBrokenLinks ignores tracked files deleted from the working tree", async (t) => {
    const repo = await documentRepo(t, { "docs/present.md": "# Present" });

    assertEquals(await findBrokenLinks(["docs/deleted.md", "docs/present.md"], repo.readTextFile, repo.pathExists), []);
});

test("historical Plan references do not relax links in lasting documentation", async (t) => {
    const repo = await documentRepo(t, {
        "docs/plans/completed.md":
            "[proposal](../prd/retired.md)\n[code](../../src/missing.ts)\n[current](../prd/current.md#missing)",
        "docs/user-guide.md": "[proposal](prd/retired.md)",
        "docs/prd/current.md": "# Current",
    });
    const lasting = await findBrokenLinks(
        ["docs/plans/completed.md", "docs/user-guide.md"],
        repo.readTextFile,
        repo.pathExists,
    );
    assertEquals(
        lasting.map((link) => [link.sourceFile, link.target]),
        [
            ["docs/plans/completed.md", "../../src/missing.ts"],
            ["docs/plans/completed.md", "../prd/current.md#missing"],
            ["docs/user-guide.md", "prd/retired.md"],
        ],
    );
});

test("findBrokenLinks rejects a fragment with no matching heading", async (t) => {
    const repo = await documentRepo(t, {
        "docs/a.md": "[gone](b.md#removed-section)",
        "docs/b.md": "# Present Section",
    });
    const broken = await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, 'no heading "#removed-section" in docs/b.md');
});

test("findBrokenLinks accepts a fragment that matches a heading", async (t) => {
    const repo = await documentRepo(t, {
        "docs/a.md": "[there](b.md#present-section)",
        "docs/b.md": "# Present Section",
    });
    assertEquals(await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists), []);
});

test("findBrokenLinks flags links that escape the repository", async (t) => {
    const repo = await documentRepo(t, { "docs/a.md": "[out](../../elsewhere.md)" });
    const broken = await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, "resolves outside the repository");
});

test("document validation ignores examples and resolves formatted and duplicate heading anchors", async (t) => {
    const repo = await documentRepo(t, {
        "docs/source.md": [
            "---",
            'summary: "[metadata](missing-metadata.md)"',
            "---",
            "[external](https://example.com)",
            "[anchor](#local)",
            "[mail](mailto:a@b.c)",
            "```md",
            "[example](missing-example.md)",
            "```",
            "[formatted](target.md#code-and-emphasis)",
            "[punctuation](target.md#execution-validation-and-delivery-model)",
            "[duplicate](target.md#title-1)",
        ].join("\n"),
        "docs/target.md": [
            "---",
            'summary: "# Title"',
            "---",
            "# Title",
            "```md",
            "# Title",
            "```",
            "## `code` and *emphasis*",
            "## Execution, Validation, and Delivery Model",
            "## Title",
        ].join("\n"),
    });
    assertEquals(await findBrokenLinks(["docs/source.md"], repo.readTextFile, repo.pathExists), []);
});
