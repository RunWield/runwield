import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import workerGlobalNames from "./window-worker-globals.json" with { type: "json" };

// API names from Deno's MIT-licensed generated worker-global inventory:
// https://github.com/denoland/deno_lint/blob/main/src/rules/no_window_prefix.rs
const workerGlobals = new Set(workerGlobalNames);

/** Rules with no direct ESLint equivalent in the existing Deno recommended gate. */
const deprecated = new Set(
    "Buffer Closer close copy customInspect File fstatSync fstat ftruncateSync ftruncate futimeSync futime isatty readAllSync readAll Reader ReaderSync readSync read run seekSync seek serveHttp Server shutdown writeAllSync writeAll Writer WriterSync writeSync write resources metrics"
        .split(" "),
);
function dotted(node: TSESTree.Node): string {
    if (node.type === "Identifier") return node.name;
    if (
        node.type === "MemberExpression" && node.computed && node.property.type === "Literal" &&
        typeof node.property.value === "string"
    ) return dotted(node.object) + "." + node.property.value;
    if (node.type === "MemberExpression" && !node.computed) return dotted(node.object) + "." + dotted(node.property);
    if (node.type === "TSQualifiedName") return dotted(node.left) + "." + dotted(node.right);
    return "";
}
function rootIdentifier(node: TSESTree.Node): TSESTree.Identifier | null {
    if (node.type === "Identifier") return node;
    if (node.type === "MemberExpression") return rootIdentifier(node.object);
    if (node.type === "TSQualifiedName") return rootIdentifier(node.left);
    return null;
}
function rule(create: TSESLint.RuleModule<string, []>["create"]): TSESLint.RuleModule<string, []> {
    return { defaultOptions: [], meta: { messages: { invalid: "{{reason}}" }, type: "problem", schema: [] }, create };
}
function invalidButtonType(value: TSESTree.Node | null | undefined): boolean {
    if (!value || value.type === "JSXEmptyExpression") return true;
    if (value.type === "Literal") return !["button", "submit", "reset"].includes(String(value.value));
    if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
        return !["button", "submit", "reset"].includes(value.quasis.map((part) => part.value.cooked).join(""));
    }
    if (value.type === "ConditionalExpression") {
        return invalidButtonType(value.consequent) || invalidButtonType(value.alternate);
    }
    return false;
}
export const rules = {
    "no-window-prefix": rule((context) => ({
        MemberExpression(node) {
            if (
                node.parent.type === "MemberExpression" || node.object.type !== "Identifier" ||
                node.object.name !== "window"
            ) return;
            const reference = context.sourceCode.getScope(node.object).references.find((item) =>
                item.identifier === node.object
            );
            if (reference?.resolved) return;
            const property = !node.computed && node.property.type === "Identifier"
                ? node.property.name
                : node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
                ? node.property.value
                : node.computed && node.property.type === "TemplateLiteral" && node.property.expressions.length === 0
                ? node.property.quasis.map((part) => part.value.raw).join("")
                : "";
            if (workerGlobals.has(property)) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "Use globalThis for APIs shared with Web Workers." },
                });
            }
        },
    })),
    "no-await-in-sync-fn": rule((context) => {
        const check = (node: TSESTree.AwaitExpression | TSESTree.ForOfStatement) => {
            if (node.type === "ForOfStatement" && !node.await) return;
            const enclosing = [...context.sourceCode.getAncestors(node)].reverse().find((ancestor) =>
                ancestor.type === "FunctionDeclaration" || ancestor.type === "FunctionExpression" ||
                ancestor.type === "ArrowFunctionExpression"
            );
            if (enclosing && "async" in enclosing && !enclosing.async) {
                context.report({ node, messageId: "invalid", data: { reason: "Await requires an async function." } });
            }
        };
        return { AwaitExpression: check, ForOfStatement: check };
    }),
    "no-this-alias": rule((context) => ({
        VariableDeclarator(node) {
            if (node.init?.type === "ThisExpression") {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "Do not alias this in a variable declaration." },
                });
            }
        },
    })),
    "jsx-button-has-type": rule((context) => ({
        JSXOpeningElement(node) {
            if (
                node.name.type !== "JSXIdentifier" || node.name.name !== "button"
            ) return;
            const attribute = node.attributes.find((attribute) =>
                attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier" &&
                attribute.name.name === "type"
            );
            if (!attribute && node.attributes.some((entry) => entry.type === "JSXSpreadAttribute")) return;
            const value = attribute?.type === "JSXAttribute" && attribute.value?.type === "JSXExpressionContainer"
                ? attribute.value.expression
                : attribute?.type === "JSXAttribute"
                ? attribute.value
                : null;
            if (
                !attribute || attribute.type !== "JSXAttribute" || !attribute.value ||
                invalidButtonType(value)
            ) context.report({ node, messageId: "invalid", data: { reason: "Buttons must declare a valid type." } });
        },
    })),
    "no-empty-enum": rule((context) => ({
        TSEnumDeclaration(node) {
            if (!node.body.members.length) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "An enum must have at least one member." },
                });
            }
        },
    })),
    "no-import-assertions": rule((context) => ({
        ImportExpression(node) {
            if (
                node.options?.type === "ObjectExpression" &&
                node.options.properties.some((property) =>
                    property.type === "Property" &&
                    ((property.key.type === "Identifier" && property.key.name === "assert") ||
                        (property.key.type === "Literal" && property.key.value === "assert"))
                )
            ) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "Use import attributes (with) instead of assertions." },
                });
            }
        },
        ImportDeclaration(node) {
            if (
                node.source &&
                context.sourceCode.getTokensAfter(node.source).some((t) =>
                    t.range[0] < node.range[1] && t.type === "Identifier" && t.value === "assert"
                )
            ) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "Use import attributes (with) instead of assertions." },
                });
            }
        },
    })),
    "no-unversioned-import": rule((context) => {
        const check = (
            node:
                | TSESTree.ImportDeclaration
                | TSESTree.ExportNamedDeclaration
                | TSESTree.ExportAllDeclaration
                | TSESTree.ImportExpression,
        ) => {
            const value = node.source?.type === "Literal" ? node.source.value : undefined;
            if (
                typeof value === "string" && /^(npm|jsr):/.test(value) &&
                !/^(?:npm|jsr):(?:@[^/]+\/)?[^/@]+@[^/]+/.test(value)
            ) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "npm: and jsr: imports must include an explicit version." },
                });
            }
        };
        return {
            ImportDeclaration: check,
            ExportNamedDeclaration: check,
            ExportAllDeclaration: check,
            ImportExpression: check,
        };
    }),
    "no-window": rule((context) => ({
        Identifier(node) {
            if (
                node.name !== "window" || (node.parent.type === "UnaryExpression" && node.parent.operator === "typeof")
            ) return;
            const reference = context.sourceCode.getScope(node).references.find((r) => r.identifier === node);
            if (reference && !reference.resolved) {
                context.report({
                    node,
                    messageId: "invalid",
                    data: { reason: "Use globalThis instead of the window global." },
                });
            }
        },
    })),
    "no-deprecated-deno-api": rule((context) => {
        const check = (node: TSESTree.MemberExpression | TSESTree.TSQualifiedName) => {
            const root = rootIdentifier(node);
            if (
                root &&
                context.sourceCode.getScope(root).references.some((reference) =>
                    reference.identifier === root && reference.resolved
                )
            ) return;
            const name = dotted(node).replace(/^(globalThis|self)\./, "");
            const parts = name.split(".");
            if (
                parts[0] === "Deno" &&
                (deprecated.has(parts[1]) ||
                    (parts[2] === "rid" &&
                        ["Conn", "FsWatcher", "Listener", "stderr", "stdin", "stdout", "TlsConn", "UnixConn"].includes(
                            parts[1],
                        )) ||
                    (parts[1] === "ListenTlsOptions" && ["certFile", "keyFile"].includes(parts[2])))
            ) context.report({ node, messageId: "invalid", data: { reason: "Deprecated Deno API: " + name } });
        };
        return {
            MemberExpression: check,
            TSQualifiedName: check,
            NewExpression(node) {
                const root = rootIdentifier(node.callee);
                if (
                    root &&
                    context.sourceCode.getScope(root).references.some((reference) =>
                        reference.identifier === root && reference.resolved
                    )
                ) return;
                if (dotted(node.callee) === "Deno.FsFile") {
                    context.report({
                        node,
                        messageId: "invalid",
                        data: { reason: "Constructing Deno.FsFile is deprecated." },
                    });
                }
            },
        };
    }),
    "no-invalid-triple-slash-reference": rule((context) => ({
        Program() {
            for (const comment of context.sourceCode.getAllComments()) {
                if (comment.type !== "Line" || !/^\/\s*<reference\b/.test(comment.value)) continue;
                const match = comment.value.match(/^\/\s*<reference\s+([\w-]+)\s*=\s*(["']).*?\2\s*\/?>\s*$/);
                const allowed = /\.[cm]?jsx?$/.test(context.filename)
                    ? ["types", "lib"]
                    : ["types", "lib", "path", "no-default-lib"];
                if (!match || !allowed.includes(match[1])) {
                    context.report({
                        loc: comment.loc,
                        messageId: "invalid",
                        data: { reason: "Invalid triple-slash reference directive." },
                    });
                }
            }
        },
    })),
    "ban-untagged-ignore": rule((context) => ({
        Program() {
            for (const comment of context.sourceCode.getAllComments()) {
                if (/^\s*deno-lint-ignore(?:-file)?\s*$/.test(comment.value)) {
                    context.report({
                        loc: comment.loc,
                        messageId: "invalid",
                        data: { reason: "Lint ignore directives must name their rules." },
                    });
                }
            }
        },
    })),
};
