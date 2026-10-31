import { readFile } from "node:fs/promises";

export const prerender = false;
const ICON_URL = new URL("../../../design-system/panel-icon.ts", import.meta.url);

export const GET = async () =>
    new Response(await readFile(ICON_URL, "utf8"), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
    });
