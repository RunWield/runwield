import assert from "node:assert/strict";
import { serve } from "bun";
import { exportAccessions } from "../src/export.ts";

if (process.argv[2] !== "empty-middle-page") throw new Error("Select empty-middle-page");
const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (cursor === null)
            return Response.json({ items: [{ accession: "A-1", title: "Vessel" }], nextCursor: "shelf-b" });
        if (cursor === "shelf-b") return Response.json({ items: [], nextCursor: "shelf-c" });
        if (cursor === "shelf-c") return Response.json({ items: [{ accession: "A-9", title: "Bronze bowl" }] });
        return new Response("Unexpected cursor", { status: 400 });
    },
});
try {
    assert.equal(
        await exportAccessions(server.url.href),
        "accession\ttitle\nA-1\tVessel\nA-9\tBronze bowl\n",
        "RV-D03-EMPTY-PAGE-CURSOR",
    );
    console.log("PASS empty-middle-page");
} finally {
    await server.stop(true);
}
