import type { APIRoute } from "astro";

import { reviewImageApi } from "../../routes/api/review-image-handlers.ts";

export const GET: APIRoute = async ({ request }) => await reviewImageApi(request);
