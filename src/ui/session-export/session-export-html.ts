/** Self-contained, read-only Session Export page. */
import { Marked } from "marked";
import type { SessionExport, SessionExportTimelineEvent } from "../../shared/session/session-export.ts";
import { renderRunWieldThemeCss } from "../design-system/theme-bridge.ts";

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

const markdown = new Marked({
    async: false,
    renderer: {
        html: ({ text }) => escapeHtml(text),
        image: () => "[image]",
        link({ href, tokens }) {
            const label = this.parser.parseInline(tokens);
            // Do not allow executable schemes or implicit resource loads from transcript content.
            // deno-lint-ignore no-control-regex -- Links must not contain ASCII control or space characters.
            if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020]/.test(href)) return label;
            return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${label}</a>`;
        },
    },
});

type ExportItem = {
    kind: "user" | "assistant" | "thinking" | "tool" | "status";
    title: string;
    text: string;
    args?: string;
    failed?: boolean;
};

function renderEvents(events: SessionExportTimelineEvent[]): string {
    const items: ExportItem[] = [];
    const messages = new Map<string, ExportItem>();
    const tools = new Map<string, ExportItem>();
    for (const event of events) {
        if (event.type === "user_message") {
            items.push({
                kind: "user",
                title: "You",
                text: event.text + (event.images?.length ? "\n[image]".repeat(event.images.length) : ""),
            });
        } else if (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta") {
            const kind = event.type === "assistant_text_delta" ? "assistant" : "thinking";
            const key = `${kind}:${event.messageId}`;
            let item = messages.get(key);
            if (!item) {
                item = { kind, title: kind === "thinking" ? "Thinking" : event.agentName || "Assistant", text: "" };
                messages.set(key, item);
                items.push(item);
            }
            item.text += event.delta;
        } else if (event.type === "tool_start" || event.type === "tool_end" || event.type === "tool_update") {
            let item = tools.get(event.toolCallId);
            if (!item) {
                item = { kind: "tool", title: event.title || event.toolName, text: "" };
                tools.set(event.toolCallId, item);
                items.push(item);
            }
            if (event.type === "tool_start") item.args = JSON.stringify(event.args, null, 2) || "";
            else {
                item.text = event.output + (event.content.some((block) => block.type === "image") ? "\n[image]" : "");
                if (event.type === "tool_end") item.failed = event.isError;
            }
        } else if (event.type === "system_status" || event.type === "terminal_error") {
            items.push({ kind: "status", title: "Status", text: event.message });
        }
    }
    return items
        .map((item) => {
            const title = escapeHtml(item.title);
            if (item.kind === "thinking" || item.kind === "tool") {
                return `<details><summary>${title}${item.failed ? " — Failed" : ""}</summary>${item.args ? `<h4>Arguments</h4><pre>${escapeHtml(item.args)}</pre><h4>Result</h4>` : ""}<pre>${escapeHtml(item.text)}</pre></details>`;
            }
            if (item.kind === "status") return `<p class="status">${escapeHtml(item.text)}</p>`;
            const body =
                item.kind === "assistant"
                    ? markdown.parse(item.text, { async: false })
                    : `<p class="user-text">${escapeHtml(item.text)}</p>`;
            return `<article class="${item.kind}"><h3>${title}</h3>${body}</article>`;
        })
        .join("\n");
}

export function renderSessionExportHtml({ document, timeline }: SessionExport): string {
    const { session } = document;
    const artifacts = document.artifacts
        .map((artifact) => `<li>${escapeHtml(artifact.title)} <code>${escapeHtml(artifact.path)}</code></li>`)
        .join("");
    const plans = document.planAssociations
        .map((plan) => `<li>${escapeHtml(plan.planName)} — ${escapeHtml(plan.purpose)}</li>`)
        .join("");
    const sections = document.segments
        .map(
            (segment) =>
                `<section aria-labelledby="segment-${segment.ordinal}"><h2 id="segment-${segment.ordinal}">${escapeHtml(segment.label)}</h2>${renderEvents(timeline.filter((event) => event.segmentOrdinal === segment.ordinal))}</section>`,
        )
        .join("\n");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(session.name || "RunWield Session")}</title><style>${renderRunWieldThemeCss()}
* { box-sizing: border-box; }
body { margin: 0; background: var(--rw-page-bg); color: var(--rw-text); font: 16px/1.65 system-ui, sans-serif; }
main { max-width: 78ch; margin: auto; padding: 32px 20px 64px; overflow-wrap: anywhere; }
h1 { color: var(--rw-text-strong); font-size: 1.75rem; line-height: 1.25; margin: 0 0 20px; }
h2 { color: var(--rw-brand); font-size: 1.2rem; border-bottom: 1px solid var(--rw-border); padding-bottom: 8px; margin: 40px 0 20px; }
h3, h4 { font-size: .875rem; color: var(--rw-text-muted); margin: 0 0 8px; }
h4 { margin-top: 16px; }
p { margin: 8px 0 16px; }
dl { font-size: .8125rem; color: var(--rw-text-muted); } dt { font-weight: 600; } dd { margin: 0 0 8px; }
article { margin: 24px 0; } article.user { padding: 12px 16px; border-radius: 6px; background: var(--rw-surface-muted); }
.user-text, pre { white-space: pre-wrap; } pre, code { font-family: ui-monospace, monospace; font-size: .875em; }
pre { background: var(--rw-surface); padding: 12px; overflow-wrap: anywhere; overflow-x: auto; }
code { color: var(--rw-code); } details { margin: 12px 0; padding: 12px; border: 1px solid var(--rw-border); border-radius: 6px; }
summary { cursor: pointer; color: var(--rw-text-muted); font-size: .875rem; } summary:hover { color: var(--rw-text-strong); }
a { color: var(--rw-accent); text-underline-offset: 3px; } a:hover { color: var(--rw-accent-strong); }
:focus-visible { outline: 2px solid var(--rw-accent); outline-offset: 4px; }
::selection { color: var(--rw-on-accent); background: var(--rw-accent); }
.status { color: var(--rw-text-dim); font-size: .875rem; } table { border-collapse: collapse; display: block; overflow-x: auto; } td, th { padding: 8px; border: 1px solid var(--rw-border); }
</style></head><body><main><header><h1>${escapeHtml(session.name || "RunWield Session")}</h1><dl><dt>Session ID</dt><dd>${escapeHtml(session.runwieldSessionId || "Not persisted")}</dd><dt>Project</dt><dd>${escapeHtml(session.cwd)}</dd><dt>Created</dt><dd>${escapeHtml(session.createdAt || "—")}</dd><dt>Updated</dt><dd>${escapeHtml(session.updatedAt || "—")}</dd><dt>Exported</dt><dd>${escapeHtml(document.exportedAt)}</dd></dl></header>
${artifacts || plans ? `<nav aria-label="Session references">${artifacts ? `<h2>Artifacts</h2><ul>${artifacts}</ul>` : ""}${plans ? `<h2>Plan Associations</h2><ul>${plans}</ul>` : ""}</nav>` : ""}
${sections}</main></body></html>`;
}
