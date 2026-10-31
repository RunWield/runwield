export interface RegistryEntry {
    id: string;
    label: string;
}
export interface RegistryData {
    entries: RegistryEntry[];
}

export function validateEntry(entry: RegistryEntry): void {
    if (!/^[a-z0-9-]+$/.test(entry.id) || !entry.label.trim()) throw new Error("Invalid registry entry");
}
