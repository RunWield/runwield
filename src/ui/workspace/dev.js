import { getCwd } from "../../constants.js";
/**
 * Dev server entry for Astro/Vite mode with HMR.
 * Exports the Workspace server wrapper for local development.
 * Token auth is disabled in dev mode (localhost-only, no exposure risk).
 */

import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../shared/work-records/mnemoteca-port.ts";
import { createWorkspaceApp } from "./server.js";

export const app = createWorkspaceApp({
    // Astro dev-server entry module, never loaded by the test suite.
    // deno-lint-ignore runwield/no-module-scope-process-state
    cwd: getCwd(),
    token: "",
    skipTokenCheck: true,
    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
});
