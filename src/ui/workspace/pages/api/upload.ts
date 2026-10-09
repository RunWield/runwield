import type { APIRoute } from "astro";

import { reviewImageUploadApi } from "../../routes/api/review-image-handlers.ts";

export const POST: APIRoute = async ({ request }) => await reviewImageUploadApi(request);
