import type { CalendarEvent } from "./model.ts";
import { writeSummary } from "./store.ts";

export async function exportSummary(path: string, events: CalendarEvent[]): Promise<void> {
    await writeSummary(path, events.map((event) => event.title).join("\n"));
}
