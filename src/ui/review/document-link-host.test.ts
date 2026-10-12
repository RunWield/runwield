import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { DocumentLinkHost } from "./document-link-host.ts";
import { reviewImageApi, reviewImageUploadApi } from "../workspace/routes/api/review-image-handlers.ts";

interface ReaderPayload {
    surface: string;
    launch: string;
    markdown: string;
    artifactKind: string;
    title: string;
    artifactPath: string;
    imageBaseDir: string;
    notices: string[];
}

async function write(root: string, path: string, contents: string): Promise<void> {
    await Deno.mkdir(dirname(join(root, path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
}

async function withProject(run: (root: string, host: DocumentLinkHost) => Promise<void>): Promise<void> {
    const root = await Deno.makeTempDir({ prefix: "document-link-host-" });
    const host = new DocumentLinkHost(root);
    try {
        await run(root, host);
    } finally {
        await host.dispose();
        await Deno.remove(root, { recursive: true });
    }
}

function resolved(host: DocumentLinkHost, path: string): string {
    const url = host.resolve(path);
    assert(url, `Expected a reader URL for ${path}`);
    return url;
}

async function readPage(url: string): Promise<ReaderPayload> {
    const response = await fetch(url);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    const match = html.match(/<script[^>]*data-review-payload[^>]*>([\s\S]*?)<\/script>/);
    assert(match, "Expected embedded reader payload");
    return JSON.parse(match[1]);
}

async function expectStatus(url: URL | string, status: number, init?: RequestInit): Promise<string> {
    const response = await fetch(url, init);
    assertEquals(response.status, status);
    if (new URL(url).pathname === "/api/image" || new URL(url).pathname === "/review/plan") {
        assertEquals(response.headers.get("cache-control"), "no-store");
    }
    return await response.text();
}

Deno.test("document host resolves Unicode and encoded names with fragments to a shared loopback reader", async () => {
    await withProject(async (root, host) => {
        await write(root, "docs/café notes %.md", "# Café\n");
        await write(root, "README.md", "# Home\n");
        const url = new URL(resolved(host, "docs/caf%C3%A9%20notes%20%25.md#details"));
        assertEquals(url.hostname, "127.0.0.1");
        assert(Number(url.port) > 0);
        assertEquals(url.pathname, "/review/plan");
        assertEquals(url.searchParams.get("path"), "docs/café notes %.md");
        assertEquals(url.hash, "#details");
        const other = new URL(resolved(host, "README.md"));
        assertEquals(other.origin, url.origin);
        assertEquals(other.searchParams.get("token"), url.searchParams.get("token"));
        assertEquals((await readPage(url.href)).markdown, "# Café\n");
    });
});

Deno.test("document host returns plain-text fallback for missing, malformed, non-Markdown and directory mentions", async () => {
    await withProject(async (root, host) => {
        await write(root, "README.md", "# Read me");
        await write(root, "text.txt", "secret");
        await Deno.mkdir(join(root, "directory.md"));
        for (
            const path of [
                "",
                "missing.md",
                "text.txt",
                "directory.md",
                "README.md/child.md",
                "%ZZ.md",
                "#section",
                "../outside.md",
                "docs/../README.md",
                "%2e%2e/outside.md",
                `${root}/README.md`,
                "bad\0.md",
                "C:\\secret.md",
                "file:README.md",
                "https://example.com/README.md",
            ]
        ) assertEquals(host.resolve(path), null, path);
        // Invalid resolutions do not prevent the first valid lazy launch.
        assertEquals((await readPage(resolved(host, "README.md"))).title, "Read me");
    });
});

Deno.test("concurrent document tabs and refresh read each current file without leaking the Project root", async () => {
    await withProject(async (root, host) => {
        await write(root, "docs/a.md", "# Alpha\nfirst");
        await write(root, "docs/b.md", "No heading");
        const a = resolved(host, "docs/a.md");
        const b = resolved(host, "docs/b.md");
        const [first, second] = await Promise.all([readPage(a), readPage(b)]);
        assertEquals(first.markdown, "# Alpha\nfirst");
        assertEquals(second.markdown, "No heading");
        assertEquals(second.title, "b.md");
        assertEquals(first.surface, "artifact-read");
        assertEquals(first.launch, "linked");
        assertEquals(first.artifactKind, "document");
        assertEquals(first.artifactPath, "docs/a.md");
        assertEquals(first.imageBaseDir, "docs");
        const html = await expectStatus(a, 200);
        assertEquals(html.includes(root), false);
        assertEquals(html.includes(Deno.realPathSync(root)), false);
        await write(root, "docs/a.md", "# Updated\ncurrent");
        assertEquals((await readPage(a)).markdown, "# Updated\ncurrent");
        assertEquals((await readPage(b)).markdown, "No heading");
        await Deno.remove(join(root, "docs/a.md"));
        await expectStatus(a, 404);
        assertEquals((await readPage(b)).markdown, "No heading");
    });
});

Deno.test("linked reader authenticates tokens and does not expose review actions or uploads", async () => {
    await withProject(async (root, host) => {
        await write(root, "README.md", "# Secret document");
        const url = new URL(resolved(host, "README.md"));
        const bad = new URL(url);
        bad.searchParams.set("token", "wrong");
        const response = await fetch(bad);
        assertEquals(response.status, 401);
        assertEquals(response.headers.get("cache-control"), "no-store");
        assertEquals((await response.text()).includes("Secret document"), false);
        bad.searchParams.delete("token");
        await expectStatus(bad, 401);
        for (const path of ["/api/review/exit", "/api/review/decision", "/api/exit", "/api/decision", "/api/upload"]) {
            const action = new URL(url);
            action.pathname = path;
            await expectStatus(action, 404, { method: "POST" });
        }
        assertEquals((await readPage(url.href)).markdown, "# Secret document");
        await expectStatus(new URL("/tokens.css", url), 200);
    });
});

Deno.test("root rebinding revokes prior links even when the relative filename exists in both Projects", async () => {
    await withProject(async (root, host) => {
        const second = await Deno.makeTempDir({ prefix: "document-link-second-" });
        try {
            await write(root, "README.md", "# First");
            await write(second, "README.md", "# Second");
            const old = resolved(host, "README.md");
            host.rebind(second);
            await expectStatus(old, 401);
            const current = resolved(host, "README.md");
            assertEquals(new URL(current).origin, new URL(old).origin);
            assertEquals((await readPage(current)).title, "Second");
            host.rebind(second);
            await expectStatus(current, 401);
            assertEquals((await readPage(resolved(host, "README.md"))).title, "Second");
        } finally {
            await Deno.remove(second, { recursive: true });
        }
    });
});

Deno.test("linked page requests reject malformed and unsafe paths without filesystem details", async () => {
    await withProject(async (root, host) => {
        await write(root, "README.md", "# Safe");
        await Deno.mkdir(join(root, "directory.md"));
        const url = new URL(resolved(host, "README.md"));
        const cases: [string, number][] = [
            ["", 400],
            ["text.txt", 400],
            ["missing.md", 404],
            ["directory.md", 404],
            ["README.md/child.md", 404],
            ["../outside.md", 403],
            ["docs/../README.md", 403],
            [`${root}/README.md`, 403],
            ["bad\0.md", 403],
            ["C:\\secret.md", 403],
            ["file:README.md", 403],
        ];
        for (const [path, status] of cases) {
            const candidate = new URL(url);
            candidate.searchParams.set("path", path);
            const body = await expectStatus(candidate, status);
            assertEquals(body.includes(root), false);
            assertEquals(body.includes("# Safe"), false);
        }
        const encoded = new URL(url);
        encoded.search = `?token=${url.searchParams.get("token")}&path=%2e%2e%2foutside.md`;
        await expectStatus(encoded, 403);
    });
});

Deno.test("canonical Markdown resolution rejects symlink escapes and non-Markdown targets on every request", async () => {
    await withProject(async (root, host) => {
        const outside = await Deno.makeTempDir({ prefix: "document-link-outside-" });
        try {
            await write(outside, "secret.md", "# Outside secret");
            await write(root, "inside.txt", "# Not Markdown");
            await Deno.symlink(join(outside, "secret.md"), join(root, "escape.md"));
            await Deno.symlink(join(root, "inside.txt"), join(root, "alias.md"));
            await Deno.symlink(outside, join(root, "escape-dir"));
            assertEquals(host.resolve("escape.md"), null);
            assertEquals(host.resolve("escape-dir/secret.md"), null);
            assertEquals(host.resolve("alias.md"), null);
            await write(root, "current.md", "# Inside");
            const url = new URL(resolved(host, "current.md"));
            const alias = new URL(url);
            alias.searchParams.set("path", "alias.md");
            await expectStatus(alias, 404);
            await Deno.remove(join(root, "current.md"));
            await Deno.symlink(join(outside, "secret.md"), join(root, "current.md"));
            const body = await expectStatus(url, 403);
            assertEquals(body.includes("Outside secret"), false);
            assertEquals(body.includes(outside), false);
        } finally {
            await Deno.remove(outside, { recursive: true });
        }
    });
});

Deno.test("known canonical artifact locations keep labels while other documents remain generic", async () => {
    await withProject(async (root, host) => {
        const cases = [
            ["docs/plans/change.md", "plan"],
            ["docs/prd/product.md", "prd"],
            ["docs/adr/decision.md", "adr"],
            ["docs/plans/epic/manual-qa.md", "epic-artifact"],
            ["docs/plans/epic/integration-report.md", "epic-artifact"],
            ["notes/manual-qa.md", "document"],
            ["docs/design-system.md", "document"],
        ];
        for (const [path, kind] of cases) {
            await write(root, path, "# Example");
            assertEquals((await readPage(resolved(host, path))).artifactKind, kind);
        }
        await Deno.symlink(join(root, "docs/prd/product.md"), join(root, "alias.md"));
        const payload = await readPage(resolved(host, "alias.md"));
        assertEquals(payload.artifactKind, "prd");
        assertEquals(payload.artifactPath, "docs/prd/product.md");
    });
});

Deno.test("linked Work Records retain verification and lifecycle notices", async () => {
    await withProject(async (root, host) => {
        await write(
            root,
            "docs/work-records/record.md",
            `---
kind: work_record
recordId: 11111111-1111-4111-8111-111111111111
status: superseded
scope: planned_change
origin: internal
completionMode: user_verified
createdAt: "2026-07-14T08:32:00-04:00"
provenance:
    sourcePlans:
        - 33333333-3333-4333-8333-333333333333
supersededBy: 22222222-2222-4222-8222-222222222222
---
# Record title

## Summary

Completed.
`,
        );
        const payload = await readPage(resolved(host, "docs/work-records/record.md"));
        assertEquals(payload.artifactKind, "work-record");
        assertEquals(payload.title, "Record title");
        assertStringIncludes(payload.notices.join("\n"), "verification was attested by the user");
        assertStringIncludes(payload.notices.join("\n"), "superseded by 22222222");
    });
});

Deno.test("linked images allow current Project files but reject symlink escapes, uploads and unsafe paths", async () => {
    await withProject(async (root, host) => {
        const outside = await Deno.makeTempDir({ prefix: "document-image-outside-" });
        try {
            await write(root, "docs/read.md", "# Images");
            await write(root, "docs/image.png", "image bytes");
            await write(root, "root-image.png", "root image bytes");
            await write(root, "root image.png", "encoded image bytes");
            await write(outside, "secret.png", "outside image secret");
            await Deno.symlink(join(outside, "secret.png"), join(root, "docs/escape.png"));
            await Deno.symlink(outside, join(root, "outside-images"));
            const page = new URL(resolved(host, "docs/read.md"));
            const image = new URL("/api/image?path=image.png&base=docs", page);
            const referer = { headers: { referer: page.href } };
            assertEquals(await expectStatus(image, 200, referer), "image bytes");
            const parentImage = new URL("/api/image?path=../root-image.png&base=docs", page);
            assertEquals(await expectStatus(parentImage, 200, referer), "root image bytes");
            const encodedImage = new URL("/api/image?path=..%2Froot%2520image.png&base=docs", page);
            assertEquals(await expectStatus(encodedImage, 200, referer), "encoded image bytes");
            parentImage.searchParams.set("path", "../../secret.png");
            await expectStatus(parentImage, 403, referer);
            await write(root, "docs/image.png", "current image");
            assertEquals(await expectStatus(image, 200, referer), "current image");
            await Deno.remove(join(root, "docs/image.png"));
            await Deno.symlink(join(outside, "secret.png"), join(root, "docs/image.png"));
            await expectStatus(image, 403, referer);
            await expectStatus(image, 401);
            await expectStatus(image, 401, {
                headers: { referer: page.href.replace(page.origin, "http://evil.test") },
            });
            image.searchParams.set("token", page.searchParams.get("token")!);
            const cases: [string, string, number][] = [
                ["escape.png", "docs", 403],
                ["secret.png", "outside-images", 403],
                [join(root, "docs/image.png"), "", 403],
                ["../docs/image.png", "docs", 403],
                ["image.png", "../docs", 403],
                ["image.png", root, 403],
                ["bad\0.png", "", 403],
                ["missing.png", "", 404],
                ["read.md", "docs", 400],
            ];
            for (const [path, base, status] of cases) {
                const candidate = new URL(image);
                candidate.searchParams.set("path", path);
                candidate.searchParams.set("base", base);
                const body = await expectStatus(candidate, status);
                assertEquals(body.includes("outside image secret"), false);
                assertEquals(body.includes(root), false);
            }
            host.rebind(root);
            await expectStatus(image, 401, referer);
        } finally {
            await Deno.remove(outside, { recursive: true });
        }
    });
});

Deno.test("existing valid review image uploads stay readable but upload symlinks cannot escape", async () => {
    await withProject(async (root, host) => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const data = new FormData();
        data.set("file", new File([bytes], "picture.png"));
        const upload = await reviewImageUploadApi(
            new Request("http://localhost/api/upload", { method: "POST", body: data }),
        );
        assertEquals(upload.status, 200);
        const uploaded: { path: string } = await upload.json();
        try {
            const image = new URL("http://localhost/api/image");
            image.searchParams.set("path", uploaded.path);
            const existing = await reviewImageApi(new Request(image), { cwd: root });
            assertEquals(existing.status, 200);
            assertEquals(new Uint8Array(await existing.arrayBuffer()), bytes);
            await write(root, "README.md", "# Reader");
            const page = new URL(resolved(host, "README.md"));
            const linked = new URL(image.pathname + image.search, page);
            linked.searchParams.set("token", page.searchParams.get("token")!);
            await expectStatus(linked, 403);
            await Deno.remove(uploaded.path);
            await write(root, "outside-upload.png", "not an upload");
            await Deno.symlink(join(root, "outside-upload.png"), uploaded.path);
            const escaped = await reviewImageApi(new Request(image), { cwd: root });
            assertEquals(escaped.status, 403);
            await escaped.text();
        } finally {
            await Deno.remove(uploaded.path).catch(() => {});
        }
    });
});

Deno.test("host disposal stops the listener and cannot be reversed by rebind", async () => {
    await withProject(async (root, host) => {
        await write(root, "README.md", "# Reader");
        const url = resolved(host, "README.md");
        await readPage(url);
        await Promise.all([host.dispose(), host.dispose()]);
        assertEquals(host.resolve("README.md"), null);
        host.rebind(root);
        assertEquals(host.resolve("README.md"), null);
        await assertRejects(() => fetch(url));
        await host.dispose();
    });
});

Deno.test("unstarted and invalid-root hosts can be disposed safely", async () => {
    await withProject(async (root, host) => {
        assertEquals(host.resolve("missing.md"), null);
        host.rebind(join(root, "missing-project"));
        assertEquals(host.resolve("README.md"), null);
        await host.dispose();
        await host.dispose();
    });
});
