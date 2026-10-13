import { readFile as fsReadFile } from "node:fs/promises";
import type { APIRoute } from "astro";

const COMPONENTS_CSS_URL = new URL("../../design-system/components.css", import.meta.url);

export const GET: APIRoute = async () => {
    const css = await fsReadFile(COMPONENTS_CSS_URL, "utf8");
    return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
};
