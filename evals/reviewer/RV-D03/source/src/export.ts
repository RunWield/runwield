import { fetchAccessions } from "./api.ts";
import { formatAccessions } from "./format.ts";

export async function exportAccessions(endpoint: string): Promise<string> {
    const page = await fetchAccessions(endpoint);
    return formatAccessions(page.items);
}
