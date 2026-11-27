import quikdown from "quikdown";

function reviewMarkdownEvidence(source: string): string {
    // Rendering can trim code, omit list ordinals, or discard extra table cells.
    // Preserve those source details, and treat raw HTML as opaque content.
    const protectedSource: string[] =
        source.match(
            /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$|(`+)[^`]*?\2|<!--[\s\S]*?-->|<([a-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\3\s*>|<\/?[a-z][^>]*>|^ {0,3}\[\^[^\]]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gim,
        ) || [];
    const ordinals = source.match(/^[ \t]*\d+\.(?=\s)/gm) || [];
    const tables: string[][][] = [];
    let rows: string[][] = [];
    let inListItem = false;
    for (const line of [...source.split(/\r?\n/), ""]) {
        if (/^[ \t]*(?:[-*+]|\d+\.)\s+\S/.test(line)) inListItem = true;
        else if (!/^[ \t]+\S/.test(line)) inListItem = false;
        if (!inListItem && /^(?: {4}|\t)/.test(line)) protectedSource.push(line);
        if (line.includes("|")) {
            rows.push(
                line
                    .trim()
                    .replace(/^\||\|$/g, "")
                    .split("|")
                    .map((cell) => cell.trim().replace(/^(:?)-+(:?)$/, "$1-$2")),
            );
        } else {
            // quikdown also recognizes consecutive pipe rows without a separator.
            if (rows.length > 1) tables.push(rows);
            rows = [];
        }
    }
    // Unsafe destinations must stay distinct. This HTML is comparison evidence only, never display output.
    const body = source.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(\r?\n)(?:[ \t]*\r?\n)+[ \t]*$/, "$1");
    const html = quikdown(body, {
        allow_unsafe_urls: true,
        reference_links: true,
    });
    // quikdown can append an unmatched paragraph closer after a terminal table
    // depending on the final blank line. Table cells are compared separately above.
    const normalized = html
        .replace(/<\/table>\n<\/p>$/, "</table>")
        .replace(/<[^>]*>|[^<]+/g, (part) => (part.startsWith("<") ? part : part.replace(/\r?\n/g, " ")));
    return JSON.stringify({ protectedSource, ordinals, tables, normalized });
}

export function sameReviewedMarkdown(left: string, right: string): boolean {
    return left === right || reviewMarkdownEvidence(left) === reviewMarkdownEvidence(right);
}
