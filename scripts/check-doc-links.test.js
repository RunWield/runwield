import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { extractRelativeLinks, findBrokenLinks, headingSlug, headingSlugs } from "./check-doc-links.js";

/**
 * @param {Record<string, string>} files
 */
function fakeRepo(files) {
    return {
        /** @param {string} path */
        readTextFile: (path) => {
            if (!(path in files)) throw Object.assign(new Error(path), { code: "ENOENT" });
            return Promise.resolve(files[path]);
        },
        /** @param {string} path */
        pathExists: (path) => Promise.resolve(path in files),
    };
}

test("extractRelativeLinks ignores absolute, anchor-only, front matter, and fenced links", () => {
    const markdown = [
        "---",
        'failureReason: "[captured](docs/not-documentation.md)"',
        "---",
        "[relative](docs/thing.md)",
        "[external](https://example.com/x.md)",
        "[anchor](#section)",
        "[mail](mailto:a@b.c)",
        "```",
        "[fenced](docs/nope.md)",
        "```",
    ].join("\n");

    assertEquals(extractRelativeLinks(markdown), [{ line: 4, target: "docs/thing.md" }]);
});

test("headingSlug matches GitHub-style anchors", () => {
    assertEquals(headingSlug("## Plan Workflow Model"), "-plan-workflow-model");
    assertEquals(headingSlug("Execution, Validation, and Delivery Model"), "execution-validation-and-delivery-model");
    assertEquals(headingSlug("`code` and *emphasis*"), "code-and-emphasis");
});

test("headingSlugs skips front matter, fenced code, and disambiguates duplicates", () => {
    const slugs = headingSlugs([
        "---",
        'summary: "# Not A Heading"',
        "---",
        "# Title",
        "```",
        "# Not A Heading",
        "```",
        "## Title",
    ].join("\n"));
    assertEquals([...slugs], ["title", "title-1"]);
});

test("findBrokenLinks resolves relative to the linking file, not the repo root", async () => {
    // The exact defect this ratchet exists for: docs/architecture.md linking
    // "docs/entity-model.md" resolves to docs/docs/entity-model.md.
    const repo = fakeRepo({
        "docs/architecture.md": "[model](docs/entity-model.md)",
        "docs/entity-model.md": "# Model",
    });
    const broken = await findBrokenLinks(["docs/architecture.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, "no such file: docs/docs/entity-model.md");
});

test("findBrokenLinks accepts a correctly resolved sibling link", async () => {
    const repo = fakeRepo({
        "docs/architecture.md": "[model](entity-model.md)",
        "docs/entity-model.md": "# Model",
    });
    assertEquals(await findBrokenLinks(["docs/architecture.md"], repo.readTextFile, repo.pathExists), []);
});

test("findBrokenLinks ignores tracked files deleted from the working tree", async () => {
    const repo = fakeRepo({ "docs/present.md": "# Present" });

    assertEquals(
        await findBrokenLinks(["docs/deleted.md", "docs/present.md"], repo.readTextFile, repo.pathExists),
        [],
    );
});

test("findBrokenLinks rejects a fragment with no matching heading", async () => {
    const repo = fakeRepo({
        "docs/a.md": "[gone](b.md#removed-section)",
        "docs/b.md": "# Present Section",
    });
    const broken = await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, 'no heading "#removed-section" in docs/b.md');
});

test("findBrokenLinks accepts a fragment that matches a heading", async () => {
    const repo = fakeRepo({
        "docs/a.md": "[there](b.md#present-section)",
        "docs/b.md": "# Present Section",
    });
    assertEquals(await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists), []);
});

test("findBrokenLinks flags links that escape the repository", async () => {
    const repo = fakeRepo({ "docs/a.md": "[out](../../elsewhere.md)" });
    const broken = await findBrokenLinks(["docs/a.md"], repo.readTextFile, repo.pathExists);

    assertEquals(broken.length, 1);
    assertEquals(broken[0].reason, "resolves outside the repository");
});
