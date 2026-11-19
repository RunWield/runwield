/**
 * Stable repository/runtime roots for source runs and bundled executables.
 *
 * This module intentionally lives at the repository root. Deno's compile
 * bundler emits its generated entrypoint at the embedded filesystem root, so
 * `import.meta.url` has the same base here in both source and bundled modes.
 */

import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";

/** Root containing the embedded `src/` and `dist/` trees. */
export const RUNWIELD_ROOT = dirname(fromFileUrl(import.meta.url));

/** Root containing RunWield's executable JavaScript and passive resources. */
export const RUNWIELD_SOURCE_ROOT = join(RUNWIELD_ROOT, "src");
