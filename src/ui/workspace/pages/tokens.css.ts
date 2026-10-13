import { readFile as fsReadFile } from "node:fs/promises";
import type { APIRoute } from "astro";

const TOKENS_CSS_URL = new URL("../../design-system/tokens.css", import.meta.url);

export const GET: APIRoute = async () => {
    const css = await fsReadFile(TOKENS_CSS_URL, "utf8");
    return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
};
