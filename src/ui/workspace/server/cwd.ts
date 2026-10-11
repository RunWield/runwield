import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

type ConstantsModule = typeof import("../../../constants.js");
type NativeConstantsImport = (specifier: string) => Promise<ConstantsModule>;

// Astro dev must load Core through Deno, which resolves its JSR imports.
// Keep the static import in production so the compiled Workspace bundles Core.
// Function cannot express its generated JavaScript signature to TypeScript.
const nativeImport = Function("specifier", "return import(specifier)") as NativeConstantsImport;
const { getCwd } = isAstroDevelopmentMode()
    ? await nativeImport(new URL("../../../constants.js", import.meta.url).href)
    : await import("../../../constants.js");

export function currentWorkspaceCwd(): string {
    return getCwd();
}
