import { test } from "node:test";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertRejects } from "../src/testing/assertions.ts";
import { join } from "node:path";
import { assertReviewAssetsAvailableInRuntime } from "./assert-workspace-review-runtime.js";

test("Workspace review runtime asset gate follows nested JS and CSS references", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-review-runtime-assets-"));
    const assetDir = join(root, "client", "_astro");
    await fsMkdir(assetDir, { recursive: true });

    try {
        await fsWriteFile(join(assetDir, "Review.js.asset"), "import './review.css';");
        await fsWriteFile(join(assetDir, "review.css"), ".icon{background:url('./icon.svg')}");
        await fsWriteFile(join(assetDir, "icon.svg"), "<svg></svg>");

        await assertReviewAssetsAvailableInRuntime(
            '<astro-island component-url="/_astro/Review.js"></astro-island>',
            "http://localhost/review/plan?token=test",
            assetDir,
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("Workspace review runtime asset gate reports missing nested assets", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-review-runtime-assets-"));
    const assetDir = join(root, "client", "_astro");
    await fsMkdir(assetDir, { recursive: true });

    try {
        await fsWriteFile(join(assetDir, "Review.js.asset"), "import './missing.css';");

        await assertRejects(
            () =>
                assertReviewAssetsAvailableInRuntime(
                    '<astro-island component-url="/_astro/Review.js"></astro-island>',
                    "http://localhost/review/plan?token=test",
                    assetDir,
                ),
            Error,
            "Workspace review runtime asset is missing",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("Workspace review runtime asset gate rejects empty asset markup", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-review-runtime-assets-"));
    try {
        await assertRejects(
            () => assertReviewAssetsAvailableInRuntime("<main></main>", "http://localhost/review/plan", root),
            Error,
            "Workspace review page did not reference any runtime assets",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("Bun Workspace review assets retain filenames and reject missing nested resources", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-bun-review-assets-"));
    try {
        await fsWriteFile(join(root, "Review.js"), "import './review.css';");
        await fsWriteFile(join(root, "review.css"), ".icon{background:url('./icon.svg')}");
        await fsWriteFile(join(root, "icon.svg"), "<svg></svg>");
        const html = '<astro-island component-url="/_astro/Review.js"></astro-island>';
        await assertReviewAssetsAvailableInRuntime(html, "http://localhost/review/plan", root, false);
        await fsRm(join(root, "icon.svg"));
        await assertRejects(
            () => assertReviewAssetsAvailableInRuntime(html, "http://localhost/review/plan", root, false),
            Error,
            "Workspace review runtime asset is missing",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});
