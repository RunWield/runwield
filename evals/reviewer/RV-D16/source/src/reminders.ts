import type { CalendarEvent } from "./model.ts";
import { localDateKey } from "./dates.ts";

export function remindersForDay(events: CalendarEvent[], day: string): string[] {
    return events.filter((event) => localDateKey(event.startsAt) === day).map((event) => event.title);
}
