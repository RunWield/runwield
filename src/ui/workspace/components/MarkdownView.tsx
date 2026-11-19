import quikdown from "quikdown";

export interface MarkdownViewProps {
    markdown: string;
}

/**
 * Render Plan markdown through the shared markdown renderer instead of custom HTML parsing.
 * quikdown escapes raw HTML and rewrites unsafe link protocols before this HTML is passed to React.
 */
export function MarkdownView({ markdown }: MarkdownViewProps) {
    const html = renderMarkdown(markdown || "");
    return html
        ? <div className="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />
        : (
            <div className="markdown-view">
                <p className="empty">No Plan body content.</p>
            </div>
        );
}

export function renderMarkdown(markdown: string): string {
    return String(quikdown(markdown || "")).trim();
}
