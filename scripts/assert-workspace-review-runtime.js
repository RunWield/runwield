import { getCwd } from "../src/constants.js";
import { readFile as fsReadFile } from "node:fs/promises";
import process from "node:process";
/**
 * Assert that the built Workspace runtime renders the real Astro review pages.
 * This is a release quality gate: Plan/Code review must not silently degrade to
 * a missing-assets or fallback page in standalone binaries.
 */

import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";
import { collectNestedReviewAssetUrls, collectReviewAssetUrls } from "./release-check.js";

const DEFAULT_RUNTIME_ENTRY = "dist/workspace-runtime/server.mjs";

/** @param {string} message */
function fail(message) {
    throw new Error(message);
}

/**
 * @param {string} html
 * @param {string} label
 */
function assertRealReviewHtml(html, label) {
    if (html.includes("Workspace review UI assets are unavailable")) {
        fail(`${label} rendered the old unavailable-assets page.`);
    }
    if (html.includes("built-in review surface")) {
        fail(`${label} rendered the static fallback instead of the Astro review UI.`);
    }
    if (html.includes("Workspace Astro build unavailable")) {
        fail(`${label} rendered the Workspace build-unavailable error.`);
    }
    if (!html.includes("data-astro-review-shell")) fail(`${label} did not render the review shell.`);
    if (!html.includes("astro-island")) fail(`${label} did not include Astro island hydration markup.`);
    if (!html.includes("/_astro/")) fail(`${label} did not reference built Astro client assets.`);
    if (html.includes("<div data-runwield-review-breakout>")) {
        fail(`${label} allowed review source to break out of its embedded JSON payload.`);
    }
}

/**
 * @param {string} html
 * @param {string} route
 * @param {Record<string, unknown>} payload
 */
function assertEmbeddedPayloadRoundTrips(html, route, payload) {
    const payloadAttribute = route === "/review/plan" ? "data-review-payload" : "data-code-review-payload";
    const openingTag = `<script type="application/json" ${payloadAttribute}>`;
    const payloadStart = html.indexOf(openingTag);
    if (payloadStart < 0) fail(`${route} did not include its embedded review payload.`);
    const jsonStart = payloadStart + openingTag.length;
    const jsonEnd = html.indexOf("</script>", jsonStart);
    if (jsonEnd < 0) fail(`${route} did not close its embedded review payload.`);
    const decoded = JSON.parse(html.slice(jsonStart, jsonEnd));
    if (JSON.stringify(decoded) !== JSON.stringify(payload)) {
        fail(`${route} did not preserve its embedded review payload.`);
    }
}

/**
 * @param {string} name
 * @returns {string}
 */
function getOpaqueWorkspaceAssetName(name) {
    return [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extname(name).toLowerCase())
        ? `${name}.asset`
        : name;
}

/**
 * @param {string} assetUrl
 * @param {string} runtimeClientAssetDir
 * @param {boolean} [opaqueAssets]
 * @returns {string}
 */
function runtimeAssetPathForUrl(assetUrl, runtimeClientAssetDir, opaqueAssets) {
    const url = new URL(assetUrl);
    const encodedName = url.pathname.slice("/_astro/".length);
    const assetName = decodeURIComponent(encodedName);
    if (!assetName || assetName.includes("..") || assetName.includes("/")) {
        fail(`Unsafe Workspace review asset path: ${url.pathname}`);
    }
    return join(runtimeClientAssetDir, opaqueAssets ? getOpaqueWorkspaceAssetName(assetName) : assetName);
}

/**
 * @param {string} html
 * @param {string} baseUrl
 * @param {string} runtimeClientAssetDir
 * @param {boolean} [opaqueAssets]
 * @returns {Promise<void>}
 */
export async function assertReviewAssetsAvailableInRuntime(html, baseUrl, runtimeClientAssetDir, opaqueAssets = true) {
    const pending = collectReviewAssetUrls(html, baseUrl);
    const seen = new Set();

    while (pending.length) {
        const assetUrl = pending.shift();
        if (!assetUrl || seen.has(assetUrl)) continue;
        seen.add(assetUrl);

        const assetPath = runtimeAssetPathForUrl(assetUrl, runtimeClientAssetDir, opaqueAssets);
        const body = await fsReadFile(assetPath).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`Workspace review runtime asset is missing: ${assetPath}`);
            }
            throw error;
        });

        if (assetUrl.endsWith(".js") || assetUrl.endsWith(".css")) {
            const source = new TextDecoder().decode(body);
            for (const nestedUrl of collectNestedReviewAssetUrls(source, assetUrl)) {
                if (!seen.has(nestedUrl)) pending.push(nestedUrl);
            }
        }
    }

    if (!seen.size) fail("Workspace review page did not reference any runtime assets.");
}

/**
 * @param {string} runtimeEntry
 * @param {string} route
 * @param {Record<string, unknown>} payload
 * @param {boolean} [bunRuntime]
 */
async function assertReviewRoute(runtimeEntry, route, payload, bunRuntime = false) {
    const absoluteRuntimeEntry = resolve(runtimeEntry);
    const entry = await import(toFileUrl(absoluteRuntimeEntry).href);
    if (typeof entry.handle !== "function") fail(`${runtimeEntry} does not export handle().`);

    const token = String(payload.token || "review-runtime-token");
    const headers = new Headers();
    headers.set("x-runwield-workspace-cwd", getCwd());
    headers.set("x-runwield-review-payload", encodeURIComponent(JSON.stringify(payload)));
    const url = `http://localhost${route}?token=${encodeURIComponent(token)}`;
    const response = await entry.handle(new Request(url, { headers }));
    const html = await response.text();
    if (response.status !== 200) fail(`${route} returned ${response.status}: ${html.slice(0, 200)}`);
    assertRealReviewHtml(html, route);
    assertEmbeddedPayloadRoundTrips(html, route, payload);
    await assertReviewAssetsAvailableInRuntime(
        html,
        url,
        join(dirname(absoluteRuntimeEntry), ...(bunRuntime ? ["..", "client", "_astro"] : ["client", "_astro"])),
        !bunRuntime,
    );
}

/** @param {string[]} [args] */
export async function main(args = process.argv.slice(2)) {
    const bunRuntime = args[0] === "--bun";
    const runtimeEntry = bunRuntime ? "dist/workspace-bun/server/entry.mjs" : args[0] || DEFAULT_RUNTIME_ENTRY;
    await assertReviewRoute(
        runtimeEntry,
        "/review/plan",
        {
            plan: "# Release quality gate Plan\n\n`</script><div data-runwield-review-breakout>source</div>`\n",
            planPath: "docs/plans/release-quality-gate.md",
            token: "plan-review-runtime-token",
            mode: "workflow",
        },
        bunRuntime,
    );
    await assertReviewRoute(
        runtimeEntry,
        "/review/code",
        {
            rawPatch:
                'diff --git a/src/example.js b/src/example.js\n--- a/src/example.js\n+++ b/src/example.js\n@@ -1 +1,3 @@\n export const a = 1;\n+export const b = 2;\n+const closingTag = "</script><div data-runwield-review-breakout>source</div>";\n',
            gitRef: "release quality gate diff",
            agentCwd: getCwd(),
            token: "code-review-runtime-token",
            mode: "workflow",
        },
        bunRuntime,
    );
    console.log(`Workspace review runtime quality gate passed for ${join(getCwd(), runtimeEntry)}.`);
}

if (import.meta.main) {
    await main();
    process.exit(0);
}
