export interface ListingConfig {
    filterEnabled?: boolean;
}
export interface ListingSettings {
    filterEnabled: boolean;
}

export function loadSettings(_configured: ListingConfig = {}): ListingSettings {
    return { filterEnabled: true };
}
