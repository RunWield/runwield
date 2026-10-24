import type { RegistryEntry } from "./model.ts";

export interface CatalogPort {
    lookup(id: string): Promise<RegistryEntry | null>;
}
export async function requireCatalogEntry(catalog: CatalogPort, id: string): Promise<RegistryEntry> {
    const entry = await catalog.lookup(id);
    if (!entry || entry.id !== id) throw new Error("Catalog refused registration");
    return entry;
}
