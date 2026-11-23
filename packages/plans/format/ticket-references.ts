/**
 * Provider-neutral Ticket Reference normalization and presentation helpers.
 */

import type { FrontMatterRecord, FrontMatterValue } from "@runwield/parsing/front-matter";

type TicketReferenceInput = FrontMatterValue | undefined;

export type TicketReferenceValue = string | number | boolean | null | TicketReferenceValue[] | TicketReferenceMetadata;

export interface TicketReferenceMetadata {
    [key: string]: TicketReferenceValue;
}

/** Provider-neutral relation to a user-identified external demand Ticket. */
export interface TicketReference extends TicketReferenceMetadata {
    /** Required user-supplied Ticket URL. Surrounding whitespace is trimmed. */
    url: string;
}

function isTicketReferenceList(value: TicketReferenceInput): value is readonly FrontMatterValue[] {
    return Array.isArray(value);
}

function isPlainRecord(value: TicketReferenceInput): value is FrontMatterRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function isYamlSafeTicketReferenceValue(value: TicketReferenceInput): value is TicketReferenceValue {
    if (value === null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) return true;
    if (isTicketReferenceList(value)) return value.every(isYamlSafeTicketReferenceValue);
    if (isPlainRecord(value)) {
        return Object.entries(value).every(
            ([key, child]) => typeof key === "string" && key.trim() && isYamlSafeTicketReferenceValue(child),
        );
    }
    return false;
}

export function normalizeTicketReferences(value: TicketReferenceInput): TicketReference[] | undefined {
    if (!isTicketReferenceList(value)) return undefined;
    const normalized: TicketReference[] = [];
    for (const item of value) {
        if (!isPlainRecord(item)) continue;
        const source = item;
        if (typeof source.url !== "string") continue;
        const url = source.url.trim();
        if (!url) continue;
        const reference: TicketReference = { url };
        for (const [key, child] of Object.entries(source)) {
            if (key === "url" || child === undefined) continue;
            if (!isYamlSafeTicketReferenceValue(child)) continue;
            reference[key] = child;
        }
        normalized.push(reference);
    }
    return normalized.length ? normalized : undefined;
}

export function normalizeTicketReferencesList(value: TicketReferenceInput): TicketReference[] {
    return normalizeTicketReferences(value) || [];
}

export function dedupeTicketReferencesByUrl(...collections: TicketReferenceInput[]): TicketReference[] | undefined {
    const result: TicketReference[] = [];
    const seen = new Set();
    for (const collection of collections) {
        for (const reference of normalizeTicketReferencesList(collection)) {
            if (seen.has(reference.url)) continue;
            seen.add(reference.url);
            result.push(reference);
        }
    }
    return result.length ? result : undefined;
}

export function safeHttpTicketReferenceUrl(value: TicketReferenceInput): string {
    if (typeof value !== "string") return "";
    const url = value.trim();
    if (!url) return "";
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "";
    } catch {
        return "";
    }
}
