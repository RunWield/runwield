import type { APIRoute } from "astro";

import { reviewLocalConfigApi } from "../../routes/api/review-file-handlers.ts";

export const POST: APIRoute = () => reviewLocalConfigApi();
