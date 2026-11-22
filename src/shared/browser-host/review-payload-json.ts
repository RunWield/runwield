/**
 * Escape JSON embedded in an HTML script element. HTML parsers recognize a
 * literal closing script tag even when the element has application/json type.
 */
export function escapeReviewPayloadJson(value: string): string {
    return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}
