import type { APIRoute } from "astro";

import { reviewOpenInAppsApi } from "../../../routes/api/review-file-handlers.ts";

export const GET: APIRoute = () => reviewOpenInAppsApi();
