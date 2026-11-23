/**
 * Escape a string for YAML double-quoted scalar content.
 *
 * JSON string escapes are valid in YAML double-quoted scalars. Using the JSON
 * serializer covers every C0 control character, including ANSI's ESC byte,
 * instead of maintaining a partial list of escapes here.
 */
export function escapeYamlDoubleQuoted(value: string): string {
    const serialized = JSON.stringify(value);
    return serialized.slice(1, -1);
}
