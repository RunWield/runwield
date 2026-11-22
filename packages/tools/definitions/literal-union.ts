import { Type, type TLiteral, type TSchemaOptions } from "typebox";

type StringLiteralSchemas<Values extends readonly string[]> = {
    -readonly [Index in keyof Values]: TLiteral<Values[Index]>;
};

/** Keep tuple positions so TypeBox can infer the union of the schema's literals. */
export function stringLiteralUnion<const Values extends readonly [string, ...string[]]>(
    values: Values,
    options?: TSchemaOptions,
) {
    const schemas = values.map((value) => Type.Literal(value)) as StringLiteralSchemas<Values>;
    return Type.Union<StringLiteralSchemas<Values>>([...schemas], options);
}
