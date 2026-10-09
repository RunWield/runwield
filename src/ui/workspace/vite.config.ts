// Workspace Vite configuration is now owned by Astro in astro.config.mjs.
// This compatibility file intentionally avoids legacy Workspace runtime plugins so stale
// direct Vite invocations do not resurrect the retired Workspace runtime.
import astroConfig from "./astro.config.mjs";

export default astroConfig.vite || {};
