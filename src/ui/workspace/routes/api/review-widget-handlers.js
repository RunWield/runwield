import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
/** Sandboxed Guided Review widget serving helpers. */

import { join } from "node:path";

/**
 * @typedef {{ dir: string, assets: Map<string, string>, contentTypes: Map<string, string> }} StoredWidget
 */

/**
 * @typedef {Object} ReviewWidgetStore
 * @property {Map<string, StoredWidget>} widgets
 * @property {(guide: Record<string, unknown>, jobId: unknown) => Promise<Record<string, unknown>>} registerGuideWidgets
 * @property {() => Promise<void>} cleanup
 */

/** @returns {ReviewWidgetStore} */
export function createReviewWidgetStore() {
    /** @type {ReviewWidgetStore["widgets"]} */
    const widgets = new Map();
    return {
        widgets,
        registerGuideWidgets: (guide, jobId) => registerGuideWidgets(widgets, guide, String(jobId || "guide")),
        cleanup: async () => {
            for (const widget of widgets.values()) await fsRm(widget.dir, { recursive: true }).catch(() => {});
            widgets.clear();
        },
    };
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ token: string, reviewPayload: Record<string, unknown>, widgets?: ReviewWidgetStore }} state
 * @returns {Response | null}
 */
export function reviewWidgetApi(request, url, state) {
    const match = /^\/api\/review\/widgets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== "GET") return null;
    const widgetId = decodeURIComponent(match[1]);
    const assetName = decodeURIComponent(match[2]);
    const stored = state.widgets?.widgets.get(widgetId);
    if (stored) return serveStoredWidget(stored, url.origin, widgetId, assetName);
    const widget = findFixtureWidget(state.reviewPayload, widgetId);
    if (!widget) return Response.json({ error: "Widget not found" }, { status: 404 });
    if (assetName !== (widget.entry || "index.html")) {
        return Response.json({ error: "Widget asset not allowed" }, { status: 404 });
    }
    return widgetResponse(String(widget.html || defaultWidgetHtml(widget)), url.origin, widgetId, [assetName]);
}

/**
 * @param {ReviewWidgetStore["widgets"]} widgets
 * @param {Record<string, unknown>} guide
 * @param {string} jobId
 */
async function registerGuideWidgets(widgets, guide, jobId) {
    const cloned = structuredClone(guide);
    const guideRecord = /** @type {Record<string, unknown>} */ (cloned);
    const topAssets = Array.isArray(guideRecord.widgetAssets) ? guideRecord.widgetAssets : [];
    const sections = Array.isArray(guideRecord.sections) ? guideRecord.sections : [];
    for (const section of sections) {
        if (!section || typeof section !== "object") continue;
        const blocks = Array.isArray(section.blocks) ? section.blocks : [];
        for (const block of blocks) {
            if (!block || typeof block !== "object" || block.type !== "widget") continue;
            const widget = /** @type {Record<string, unknown>} */ (block);
            const rawId = String(widget.id || widget.widgetId || "widget");
            const id = `${jobId}-${rawId}-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
            const dir = await mkdtemp(join(tmpdir(), "runwield-guide-widget-"));
            /** @type {StoredWidget} */
            const stored = { dir, assets: new Map(), contentTypes: new Map() };
            await writeAsset(
                stored,
                "index.html",
                typeof widget.html === "string" ? widget.html : defaultWidgetHtml(widget),
                "text/html; charset=utf-8",
            );
            for (const asset of collectWidgetAssets(rawId, widget, topAssets)) {
                const record = /** @type {Record<string, unknown>} */ (asset);
                await writeAsset(
                    stored,
                    String(record.name || record.path),
                    String(record.content),
                    String(record.contentType),
                );
            }
            widgets.set(id, stored);
            widget.id = id;
            widget.entry = "index.html";
            delete widget.html;
            delete widget.assets;
        }
    }
    delete guideRecord.widgetAssets;
    return /** @type {Record<string, unknown>} */ (cloned);
}

/** @param {Record<string, unknown>} widget */
function defaultWidgetHtml(widget) {
    const data = JSON.stringify(widget.data || {});
    return `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:14px system-ui;padding:16px}button{border:1px solid #38bdf8;background:#082f49;color:#e0f2fe;border-radius:8px;padding:8px 10px}</style><h1>${
        escapeHtml(String(widget.title || "Guided Review Widget"))
    }</h1><p>${
        escapeHtml(String(widget.reason || "Interactive visual aid."))
    }</p><button id="toggle">Toggle sample state</button><pre id="out"></pre><script>const data=${data};let on=false;toggle.onclick=()=>{on=!on;out.textContent=JSON.stringify({active:on,data},null,2)};toggle.click();</script>`;
}

/** @param {string} rawId @param {Record<string, unknown>} widget @param {unknown[]} topAssets */
function collectWidgetAssets(rawId, widget, topAssets) {
    const local = Array.isArray(widget.assets) ? widget.assets : [];
    const scoped = topAssets.filter((asset) => {
        if (!asset || typeof asset !== "object") return false;
        const record = /** @type {Record<string, unknown>} */ (asset);
        return record.widgetId === rawId || record.id === rawId;
    });
    return [...local, ...scoped].filter((asset) => asset && typeof asset === "object");
}

/** @param {StoredWidget} stored @param {string} assetName @param {string} content @param {string} contentType */
async function writeAsset(stored, assetName, content, contentType) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(assetName)) throw new Error(`Unsafe widget asset name: ${assetName}`);
    const path = join(stored.dir, assetName);
    await fsWriteFile(path, content);
    stored.assets.set(assetName, path);
    stored.contentTypes.set(assetName, contentType);
}

/** @param {StoredWidget} widget @param {string} origin @param {string} widgetId @param {string} assetName */
function serveStoredWidget(widget, origin, widgetId, assetName) {
    const path = widget.assets.get(assetName);
    if (!path) return Response.json({ error: "Widget asset not allowed" }, { status: 404 });
    const contentType = widget.contentTypes.get(assetName) || "application/octet-stream";
    return new Response(readFileSync(path), {
        headers: {
            "content-type": contentType,
            "cache-control": "no-store",
            "content-security-policy": widgetCsp(origin, widgetId, [...widget.assets.keys()]),
        },
    });
}

/** @param {string} html @param {string} origin @param {string} widgetId @param {string[]} assets */
function widgetResponse(html, origin, widgetId, assets) {
    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": widgetCsp(origin, widgetId, assets),
        },
    });
}

/** @param {string} origin @param {string} widgetId @param {string[]} assets */
function widgetCsp(origin, widgetId, assets) {
    const safeOrigin = origin.replace(/;|,|\s/g, "");
    const assetSources = assets
        .filter((asset) => asset !== "index.html")
        .map((asset) =>
            `${safeOrigin}/api/review/widgets/${encodeURIComponent(widgetId)}/${encodeURIComponent(asset)}`
        );
    const localAssetSources = assetSources.join(" ");
    const localSuffix = localAssetSources ? ` ${localAssetSources}` : "";
    return [
        "default-src 'none'",
        `script-src 'unsafe-inline'${localSuffix}`,
        `style-src 'unsafe-inline'${localSuffix}`,
        `img-src data:${localSuffix}`,
        `font-src data:${localSuffix}`,
        localSuffix ? `media-src${localSuffix}` : "media-src 'none'",
        "connect-src 'none'",
        "navigate-to 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
    ].join("; ");
}

/** @param {Record<string, unknown>} payload @param {string} id */
function findFixtureWidget(payload, id) {
    const guide = payload.guidedReviewFixture;
    if (!guide || typeof guide !== "object") return null;
    const guideRecord = /** @type {{ sections?: unknown }} */ (guide);
    for (const section of Array.isArray(guideRecord.sections) ? guideRecord.sections : []) {
        for (const block of Array.isArray(section?.blocks) ? section.blocks : []) {
            if (block?.type === "widget" && (block.id || block.widgetId) === id) return block;
        }
    }
    return null;
}

/** @param {string} value */
function escapeHtml(value) {
    const entities = /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" });
    return value.replace(/[&<>"]/g, (char) => entities[char] || char);
}
