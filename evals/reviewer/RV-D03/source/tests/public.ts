import assert from "node:assert/strict";
import { serve } from "bun";
import { exportAccessions } from "../src/export.ts";
import type { AccessionPage } from "../src/model.ts";

interface PageRoute {
    cursor: string | null;
    page: AccessionPage;
}
async function withApi(routes: PageRoute[], check: (endpoint: string) => Promise<void>): Promise<void> {
    const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== "/accessions") return new Response("Not found", { status: 404 });
            const route = routes.find((route) => route.cursor === url.searchParams.get("cursor"));
            return route ? Response.json(route.page) : new Response("Unexpected cursor", { status: 400 });
        },
    });
    try {
        await check(server.url.href);
    } finally {
        await server.stop(true);
    }
}
await withApi([{ cursor: null, page: { items: [{ accession: "A-1", title: "Clay\tVessel" }] } }], async (endpoint) => {
    assert.equal(await exportAccessions(endpoint), "accession\ttitle\nA-1\tClay Vessel\n");
});
console.log("PASS exports a terminal page as safe TSV");
await withApi([], async (endpoint) => {
    await assert.rejects(exportAccessions(endpoint), /Accession API returned 400/);
});
console.log("PASS API failures do not become successful empty exports");
