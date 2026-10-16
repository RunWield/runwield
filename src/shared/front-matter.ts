import { load } from "js-yaml";

export type FrontMatterValue =
    null | boolean | number | string | Date | readonly FrontMatterValue[] | FrontMatterRecord;
export interface FrontMatterRecord {
    [key: string]: FrontMatterValue | undefined;
}
export interface FrontMatter<T> {
    attrs: T;
    body: string;
    frontMatter: string;
}

// Preserve the existing Markdown delimiter grammar, including BOM, CRLF and explicit format labels.
function pattern(header: string, footer: string): RegExp {
    return new RegExp(
        `^\\ufeff?(?:${header})\\s*\\r?\\n\\s*(?:(?<frontMatter>.+?)\\s*\\r?\\n)?(?:${footer})\\s*(?:\\r?\\n(?<body>.+))?$`,
        "is",
    );
}
const yaml = pattern("---yaml|= yaml =|---", "= yaml =|---");
const formats = [
    yaml,
    pattern("---toml|\\+\\+\\+|= toml =", "---|\\+\\+\\+|= toml ="),
    pattern("---json|= json =", "---|= json ="),
];

export function test(text: string): boolean {
    return formats.some((format) => format.test(text));
}

export function extractYaml<T = FrontMatterRecord>(text: string): FrontMatter<T> {
    const groups = yaml.exec(text)?.groups;
    if (!groups) throw new TypeError("Unexpected end of input");
    const { frontMatter = "", body = "" } = groups;
    return { frontMatter, body, attrs: (frontMatter ? load(frontMatter) : {}) as T };
}
