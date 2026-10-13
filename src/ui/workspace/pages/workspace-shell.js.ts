import { readFile } from "node:fs/promises";

export const prerender = false;

export const GET = async () => {
    const scriptUrl = new URL("../static/workspace-shell.ts", import.meta.url);
    const body = await readFile(scriptUrl, "utf8");
    return new Response(body, {
        headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
        },
    });
};
