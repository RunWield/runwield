import { readFile as fsReadFile } from "node:fs/promises";
import type { APIRoute } from "astro";

const LOGO_URL = new URL("../../../../../brand/logo.svg", import.meta.url);

export const GET: APIRoute = async () => {
    const logo = await fsReadFile(LOGO_URL, "utf8");
    return new Response(logo, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
};
