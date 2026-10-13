/**
 * @module acp/schema-conformance
 * Validates ACP frames against the JSON Schema published by @agentclientprotocol/sdk.
 *
 * The SDK keeps its generated zod schemas private, but ships `schema/schema.json`
 * as a public export. That file is the authority here, so a protocol change shows
 * up as a test failure instead of silently passing.
 *
 * Test support only. The ACP schema declares no `additionalProperties: false`,
 * so this checker covers the keywords the schema actually uses and nothing more.
 */

import acpSchemaDocument from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The keywords the ACP schema actually uses. Values are optional because the
 * generated JSON gives sibling branches `undefined` for keys they do not set.
 */
type JsonSchemaNode = {
    $ref?: string;
    type?: string | string[];
    const?: JsonValue;
    enum?: readonly JsonValue[];
    required?: readonly string[];
    properties?: Record<string, JsonSchemaNode | undefined>;
    items?: JsonSchemaNode;
    allOf?: readonly JsonSchemaNode[];
    anyOf?: readonly JsonSchemaNode[];
    oneOf?: readonly JsonSchemaNode[];
    not?: JsonSchemaNode;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    format?: string;
    additionalProperties?: boolean | JsonSchemaNode;
    unevaluatedProperties?: boolean | JsonSchemaNode;
};

type AcpSchemaDocument = {
    $defs: Record<string, JsonSchemaNode | undefined>;
};

const schema = acpSchemaDocument as AcpSchemaDocument;

const DEF_REF_PREFIX = "#/$defs/";

/**
 * Resolve a local `#/$defs/Name` reference.
 *
 * @param ref reference string from the schema
 */
function resolveRef(ref: string): JsonSchemaNode {
    if (!ref.startsWith(DEF_REF_PREFIX)) throw new Error(`Unsupported ACP schema reference: ${ref}`);
    const name = ref.slice(DEF_REF_PREFIX.length);
    const definition = schema.$defs[name];
    if (!definition) throw new Error(`Unknown ACP schema definition: ${name}`);
    return definition;
}

/**
 * Report whether a value matches one JSON Schema primitive type name.
 *
 * @param typeName JSON Schema type name
 * @param value value under test
 */
function matchesType(typeName: string, value: JsonValue): boolean {
    switch (typeName) {
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "null":
            return value === null;
        default:
            throw new Error(`Unsupported ACP schema type: ${typeName}`);
    }
}

/**
 * Report whether a number satisfies one ACP integer or string format.
 *
 * @param format JSON Schema format name
 * @param value value under test
 */
function matchesFormat(format: string, value: JsonValue): boolean {
    switch (format) {
        case "double":
            return typeof value === "number" && Number.isFinite(value);
        case "int32":
            return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 &&
                value <= 2_147_483_647;
        case "int64":
            return typeof value === "number" && Number.isSafeInteger(value);
        case "uint16":
            return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65_535;
        case "uint32":
            return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4_294_967_295;
        case "uint64":
            return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        case "uri":
            if (typeof value !== "string") return true;
            try {
                new URL(value);
                return true;
            } catch {
                return false;
            }
        default:
            throw new Error(`Unsupported ACP schema format: ${format}`);
    }
}

/**
 * Collect schema violations for one value, resolving refs and combinators.
 *
 * @param node schema node to apply
 * @param value value under test
 * @param path JSON path used in messages
 */
function collectViolations(node: JsonSchemaNode, value: JsonValue, path: string): string[] {
    const violations: string[] = [];
    if (node.$ref) return collectViolations(resolveRef(node.$ref), value, path);

    if (node.type !== undefined) {
        const names = Array.isArray(node.type) ? node.type : [node.type];
        if (!names.some((name) => matchesType(name, value))) {
            violations.push(`${path}: expected type ${names.join("|")}, got ${JSON.stringify(value)}`);
            return violations;
        }
    }
    if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
        violations.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`);
    }
    if (node.enum && !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
        violations.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
    }
    if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) {
        violations.push(`${path}: ${value} is below minimum ${node.minimum}`);
    }
    if (node.maximum !== undefined && typeof value === "number" && value > node.maximum) {
        violations.push(`${path}: ${value} is above maximum ${node.maximum}`);
    }
    if (node.format && !matchesFormat(node.format, value)) {
        violations.push(`${path}: ${JSON.stringify(value)} does not match format ${node.format}`);
    }
    if (node.minLength !== undefined && typeof value === "string" && value.length < node.minLength) {
        violations.push(`${path}: string length ${value.length} is below minLength ${node.minLength}`);
    }
    if (node.maxLength !== undefined && typeof value === "string" && value.length > node.maxLength) {
        violations.push(`${path}: string length ${value.length} is above maxLength ${node.maxLength}`);
    }
    if (node.pattern && typeof value === "string" && !(new RegExp(node.pattern).test(value))) {
        violations.push(`${path}: ${JSON.stringify(value)} does not match pattern ${node.pattern}`);
    }
    if (node.minItems !== undefined && Array.isArray(value) && value.length < node.minItems) {
        violations.push(`${path}: array length ${value.length} is below minItems ${node.minItems}`);
    }
    if (node.maxItems !== undefined && Array.isArray(value) && value.length > node.maxItems) {
        violations.push(`${path}: array length ${value.length} is above maxItems ${node.maxItems}`);
    }
    if (node.not && collectViolations(node.not, value, path).length === 0) {
        violations.push(`${path}: value matched a forbidden schema`);
    }

    const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
    if (isObject) {
        const record = value as { [key: string]: JsonValue };
        const propertySchemas = node.properties || {};
        for (const key of node.required || []) {
            if (!Object.hasOwn(record, key)) violations.push(`${path}: missing required property "${key}"`);
        }
        for (const [key, propertySchema] of Object.entries(propertySchemas)) {
            if (!propertySchema || !Object.hasOwn(record, key)) continue;
            violations.push(...collectViolations(propertySchema, record[key], `${path}.${key}`));
        }
        if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
            const knownProperties = new Set(Object.keys(propertySchemas));
            for (const [key, entry] of Object.entries(record)) {
                if (knownProperties.has(key)) continue;
                if (node.additionalProperties === false) {
                    violations.push(`${path}.${key}: unexpected additional property`);
                } else {
                    violations.push(...collectViolations(node.additionalProperties, entry, `${path}.${key}`));
                }
            }
        }
    }
    if (node.items && Array.isArray(value)) {
        value.forEach((entry, index) => {
            violations.push(...collectViolations(node.items as JsonSchemaNode, entry, `${path}[${index}]`));
        });
    }

    for (const subSchema of node.allOf || []) violations.push(...collectViolations(subSchema, value, path));
    if (node.anyOf) {
        const branchViolations = node.anyOf.map((branch) => collectViolations(branch, value, path));
        if (!branchViolations.some((found) => found.length === 0)) {
            violations.push(`${path}: matched no anyOf branch (${branchViolations.flat().join("; ")})`);
        }
    }
    if (node.oneOf) {
        const branchViolations = node.oneOf.map((branch) => collectViolations(branch, value, path));
        const matchCount = branchViolations.filter((found) => found.length === 0).length;
        if (matchCount !== 1) {
            violations.push(`${path}: matched ${matchCount} oneOf branches (${branchViolations.flat().join("; ")})`);
        }
    }
    return violations;
}

/**
 * List the ways a value fails one named ACP schema definition.
 *
 * @param definitionName key under the schema's `$defs`
 * @param value value under test
 */
export function findAcpSchemaViolations(definitionName: string, value: JsonValue): string[] {
    const definition = schema.$defs[definitionName];
    if (!definition) throw new Error(`Unknown ACP schema definition: ${definitionName}`);
    return collectViolations(definition, value, definitionName);
}

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
