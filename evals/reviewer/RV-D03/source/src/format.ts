import type { Accession } from "./model.ts";

function cell(value: string): string {
    return value.replace(/[\t\r\n]/g, " ");
}
export function formatAccessions(items: Accession[]): string {
    const rows = items.map((item) => `${cell(item.accession)}\t${cell(item.title)}`);
    return ["accession\ttitle", ...rows].join("\n") + "\n";
}
