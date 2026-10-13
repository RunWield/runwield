import { parseTree, getNodeValue, printParseErrorCode, type ParseError } from "jsonc-parser";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
export interface JsonRecord {
    [key: string]: JsonValue;
}

function plainValue(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(plainValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainValue(child)]));
    }
    return value;
}

/** Accept comments and trailing commas, but never return a fault-tolerant partial document. */
export function parse(text: string): JsonValue {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length) {
        const first = errors[0];
        throw new SyntaxError(`Cannot parse JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
    }
    if (!tree) throw new SyntaxError("Cannot parse JSONC: missing value");
    // getNodeValue uses null-prototype records. Materialize ordinary own properties without
    // assigning __proto__, matching JSON.parse and preserving all valid JSON keys and numbers.
    return plainValue(getNodeValue(tree));
}
