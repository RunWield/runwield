/**
 * @module scripts/lint-rules/no-module-scope-process-state
 *
 * Bans reading process-global state at module scope.
 *
 * `deno test` runs every test file in one process but gives each its own module
 * realm, initialized at an arbitrary moment. A module-scope read of `Deno.cwd()`
 * or `Deno.env` therefore snapshots whatever another test file happened to have
 * set at that instant, and keeps it for the life of the realm. That is how test
 * runs came to rewrite a developer's real `~/.wld` and how `CWD` pointed at
 * another test's temp directory.
 *
 * Read these inside a function instead — via `getHomeDir()` / `getCwd()` from
 * `src/constants.js`, which is the one module allowed to touch them directly.
 */

import type { TSESTree } from "@typescript-eslint/utils";

interface ProcessStateReport {
    node: TSESTree.CallExpression;
    message: string;
    hint: string;
}

interface ProcessStateRuleContext {
    filename: string;
    report(diagnostic: ProcessStateReport): void;
}

/** Calls that must not appear at module scope. */
const BANNED = new Map([
    ["Deno.cwd", "Deno.cwd()"],
    ["Deno.env.get", "Deno.env.get()"],
    ["Deno.env.toObject", "Deno.env.toObject()"],
    ["getHomeDir", "getHomeDir()"],
    ["getCwd", "getCwd()"],
]);

/**
 * Flatten a member expression back to dotted source text (`Deno.env.get`).
 */
function calleeName(node: TSESTree.Node | null | undefined): string {
    if (!node) return "";
    if (node.type === "Identifier") return node.name;
    if (node.type === "MemberExpression" && !node.computed) {
        const object = calleeName(node.object);
        const property = calleeName(node.property);
        return object && property ? `${object}.${property}` : "";
    }
    return "";
}

export default {
    name: "runwield",
    rules: {
        "no-module-scope-process-state": {
            create(context: ProcessStateRuleContext) {
                // constants.js owns the accessors every other module calls.
                if (context.filename.replace(/\\/g, "/").endsWith("/src/constants.js")) return {};

                let functionDepth = 0;
                const enter = () => {
                    functionDepth += 1;
                };
                const exit = () => {
                    functionDepth -= 1;
                };

                return {
                    FunctionDeclaration: enter,
                    "FunctionDeclaration:exit": exit,
                    FunctionExpression: enter,
                    "FunctionExpression:exit": exit,
                    ArrowFunctionExpression: enter,
                    "ArrowFunctionExpression:exit": exit,
                    CallExpression(node: TSESTree.CallExpression) {
                        if (functionDepth > 0) return;
                        const name = calleeName(node.callee);
                        const label = BANNED.get(name);
                        if (!label) return;
                        context.report({
                            node,
                            message: `${label} must not be called at module scope.`,
                            hint:
                                "Module scope runs once per test realm, at an arbitrary moment, so this snapshots " +
                                "another test file's cwd/env for the life of the realm. Call it inside a function " +
                                "(use getHomeDir()/getCwd() from src/constants.js).",
                        });
                    },
                };
            },
        },
    },
};
