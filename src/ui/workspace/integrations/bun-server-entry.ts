import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import { env } from "node:process";

setGetEnv((name) => env[name]);
const app = createApp();

export function handle(request: Request): Promise<Response> {
    return app.render(request);
}
