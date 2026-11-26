import type { JsonValue } from "@runwield/parsing/jsonc";
import { findAcpSchemaViolations } from "@runwield/acp/protocol";

/**
 * Throw unless a value matches one named ACP schema definition.
 *
 * @param definitionName key under the schema's `$defs`
 * @param value value under test
 */
export function assertAcpSchema(definitionName: string, value: JsonValue): void {
    const violations = findAcpSchemaViolations(definitionName, value);
    if (violations.length > 0) {
        throw new Error(`ACP ${definitionName} schema violations:\n  ${violations.join("\n  ")}`);
    }
}

/**
 * Parse one serialized NDJSON frame and assert its payload matches an ACP definition.
 *
 * Validating the serialized text keeps the assertion honest about what a strict
 * Client actually receives, not just what the adapter built in memory.
 *
 * @param definitionName key under the schema's `$defs`
 * @param frame a single NDJSON line holding a JSON-RPC message
 * @param select picks the validated payload out of the parsed frame
 */
export function assertAcpFrameSchema(
    definitionName: string,
    frame: string,
    select: (message: { [key: string]: JsonValue }) => JsonValue,
): void {
    let parsed: JsonValue;
    try {
        parsed = JSON.parse(frame);
    } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(`ACP ${definitionName} frame is not valid JSON: ${details}\n  Frame: ${frame}`, {
            cause: error,
        });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        const actualType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
        throw new Error(`ACP ${definitionName} frame must be a JSON object, got ${actualType}\n  Frame: ${frame}`);
    }
    assertAcpSchema(definitionName, select(parsed));
}
