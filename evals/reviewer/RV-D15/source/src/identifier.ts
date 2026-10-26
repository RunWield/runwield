export function validateIdentifier(id: string): void {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("Invalid workspace identifier: " + id);
}
