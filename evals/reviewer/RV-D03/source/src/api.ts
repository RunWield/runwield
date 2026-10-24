import type { AccessionPage } from "./model.ts";

export async function fetchAccessions(endpoint: string, cursor?: string): Promise<AccessionPage> {
    const url = new URL("accessions", endpoint.endsWith("/") ? endpoint : endpoint + "/");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Accession API returned ${response.status}`);
    return response.json();
}
