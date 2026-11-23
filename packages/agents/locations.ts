import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeDir } from "@runwield/resources/home";
import { personalGlobalRoot } from "@runwield/resources/personal";

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(modulePath);
// Bun bundles fold this module into a root entry point. Both runtime distributions
// place the packaged Agents assets under packages/agents next to that entry point.
const packageDir =
    basename(modulePath) === "locations.ts" && basename(moduleDir) === "agents"
        ? moduleDir
        : join(moduleDir, "packages", "agents");

export const BUNDLED_DEFINITIONS_DIR = join(packageDir, "definitions");
export const SYSTEM_PROMPT_TEMPLATE_PATH = join(packageDir, "SYSTEM_PROMPT_TEMPLATE.md");

export function personalDefinitionsDir(): string {
    return join(personalGlobalRoot(), "agents");
}

export function projectDefinitionsDir(projectRoot: string): string {
    return join(projectRoot, ".wld", "agents");
}

export function bundledDefinitionsCacheDir(): string | null {
    const home = getHomeDir();
    return home ? join(home, ".wld", "bundled-agent-definitions") : null;
}
