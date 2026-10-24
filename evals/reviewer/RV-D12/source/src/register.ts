import type { CatalogPort } from "./catalog.ts";
import { requireCatalogEntry } from "./catalog.ts";
import { validateEntry } from "./model.ts";
import { putEntry } from "./registry.ts";
import { withRegistryLock } from "./lock.ts";

export async function registerProject(root: string, id: string, catalog: CatalogPort) {
    const entry = await requireCatalogEntry(catalog, id);
    validateEntry(entry);
    return withRegistryLock(root, async () => {
        await putEntry(root, entry);
        return entry;
    });
}
