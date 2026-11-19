import type { APIRoute } from "astro";

import { handleRemoteSpaceApi } from "../../../server/remote-dev-api.ts";

export const prerender = false;
export const GET: APIRoute = handleRemoteSpaceApi;
export const POST: APIRoute = handleRemoteSpaceApi;
