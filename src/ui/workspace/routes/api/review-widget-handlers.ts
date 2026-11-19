import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
/** Sandboxed Guided Review widget serving helpers. */

import { join } from "node:path";

export interface StoredWidget {
    dir: string;
    assets: Map<string, string>;
    contentTypes: Map<string, string>;
}

/** Guide and fixture fields originate in JavaScript and retain their existing runtime checks. */
export interface ReviewWidgetGuide {
    [key: string]: unknown;
    widgetAssets?: unknown;
    sections?: unknown;
}

export interface ReviewWidgetStore {
    widgets: Map<string, StoredWidget>;
    registerGuideWidgets: (guide: ReviewWidgetGuide, jobId: unknown) => Promise<ReviewWidgetGuide>;
    cleanup: () => Promise<void>;
}

export interface ReviewWidgetPayload {
    [key: string]: unknown;
    guidedReviewFixture?: unknown;
}

export interface ReviewWidgetApiState {
    token: string;
    reviewPayload: ReviewWidgetPayload;
    widgets?: ReviewWidgetStore;
}

interface RawWidgetSection {
    blocks?: unknown;
}

interface RawReviewWidget {
    [key: string]: unknown;
    type?: unknown;
    id?: unknown;
    widgetId?: unknown;
    entry?: unknown;
    html?: unknown;
    assets?: unknown;
    data?: unknown;
    title?: unknown;
    reason?: unknown;
}

interface RawWidgetAsset {
    widgetId?: unknown;
    id?: unknown;
    name?: unknown;
    path?: unknown;
    content?: unknown;
    contentType?: unknown;
}

interface HtmlEntityMap {
    [char: string]: string;
}

export function createReviewWidgetStore(): ReviewWidgetStore {
    const widgets: ReviewWidgetStore["widgets"] = new Map();
    return {
        widgets,
        registerGuideWidgets: (guide, jobId) => registerGuideWidgets(widgets, guide, String(jobId || "guide")),
        cleanup: async () => {
            for (const widget of widgets.values()) await fsRm(widget.dir, { recursive: true }).catch(() => {});
            widgets.clear();
        },
    };
}

export function reviewWidgetApi(request: Request, url: URL, state: ReviewWidgetApiState): Response | null {
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

async function registerGuideWidgets(widgets: ReviewWidgetStore["widgets"], guide: ReviewWidgetGuide, jobId: string) {
    const cloned = structuredClone(guide);
    const guideRecord = cloned;
    const topAssets = Array.isArray(guideRecord.widgetAssets) ? guideRecord.widgetAssets : [];
    const sections: RawWidgetSection[] = Array.isArray(guideRecord.sections) ? guideRecord.sections : [];
    for (const section of sections) {
        if (!section || typeof section !== "object") continue;
        const blocks: RawReviewWidget[] = Array.isArray(section.blocks) ? section.blocks : [];
        for (const block of blocks) {
            if (!block || typeof block !== "object" || block.type !== "widget") continue;
            const widget = block;
            const rawId = String(widget.id || widget.widgetId || "widget");
            const id = `${jobId}-${rawId}-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
            const dir = await mkdtemp(join(tmpdir(), "runwield-guide-widget-"));

            const stored: StoredWidget = { dir, assets: new Map(), contentTypes: new Map() };
            await writeAsset(
                stored,
                "index.html",
                typeof widget.html === "string" ? widget.html : defaultWidgetHtml(widget),
                "text/html; charset=utf-8",
            );
            for (const asset of collectWidgetAssets(rawId, widget, topAssets)) {
                const record = asset as RawWidgetAsset;
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
    return cloned;
}

function defaultWidgetHtml(widget: RawReviewWidget) {
    const data = JSON.stringify(widget.data || {});
    return `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:14px system-ui;padding:16px}button{border:1px solid #38bdf8;background:#082f49;color:#e0f2fe;border-radius:8px;padding:8px 10px}</style><h1>${escapeHtml(
        String(widget.title || "Guided Review Widget"),
    )}</h1><p>${escapeHtml(
        String(widget.reason || "Interactive visual aid."),
    )}</p><button id="toggle">Toggle sample state</button><pre id="out"></pre><script>const data=${data};let on=false;toggle.onclick=()=>{on=!on;out.textContent=JSON.stringify({active:on,data},null,2)};toggle.click();</script>`;
}

function collectWidgetAssets(rawId: string, widget: RawReviewWidget, topAssets: unknown[]) {
    const local: unknown[] = Array.isArray(widget.assets) ? widget.assets : [];
    const scoped = topAssets.filter((asset) => {
        if (!asset || typeof asset !== "object") return false;
        const record = asset as RawWidgetAsset;
        return record.widgetId === rawId || record.id === rawId;
    });
    return [...local, ...scoped].filter((asset) => asset && typeof asset === "object");
}

async function writeAsset(stored: StoredWidget, assetName: string, content: string, contentType: string) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(assetName)) throw new Error(`Unsafe widget asset name: ${assetName}`);
    const path = join(stored.dir, assetName);
    await fsWriteFile(path, content);
    stored.assets.set(assetName, path);
    stored.contentTypes.set(assetName, contentType);
}

function serveStoredWidget(widget: StoredWidget, origin: string, widgetId: string, assetName: string) {
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

function widgetResponse(html: string, origin: string, widgetId: string, assets: string[]) {
    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": widgetCsp(origin, widgetId, assets),
        },
    });
}

function widgetCsp(origin: string, widgetId: string, assets: string[]) {
    const safeOrigin = origin.replace(/;|,|\s/g, "");
    const assetSources = assets
        .filter((asset) => asset !== "index.html")
        .map(
            (asset) => `${safeOrigin}/api/review/widgets/${encodeURIComponent(widgetId)}/${encodeURIComponent(asset)}`,
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

function findFixtureWidget(payload: ReviewWidgetPayload, id: string) {
    const guide = payload.guidedReviewFixture;
    if (!guide || typeof guide !== "object") return null;
    const guideRecord = guide as ReviewWidgetGuide;
    for (const section of (Array.isArray(guideRecord.sections) ? guideRecord.sections : []) as RawWidgetSection[]) {
        for (const block of (Array.isArray(section?.blocks) ? section.blocks : []) as RawReviewWidget[]) {
            if (block?.type === "widget" && (block.id || block.widgetId) === id) return block;
        }
    }
    return null;
}

function escapeHtml(value: string) {
    const entities: HtmlEntityMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return value.replace(/[&<>"]/g, (char) => entities[char] || char);
}
