import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
import type { ResolvedPaths } from "./package-resources.ts";
import {
    countPackageResourcesForSource,
    filterEnabledPackagePrompts,
    getPackagePromptTemplatePaths,
} from "./package-resources.ts";

test("filterEnabledPackagePrompts returns enabled package prompts only", () => {
    const resolved: ResolvedPaths = {
        themes: [],
        extensions: [],
        skills: [],
        prompts: [
            {
                path: "/pkg/prompts/explain.md",
                enabled: true,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
            {
                path: "/pkg/prompts/off.md",
                enabled: false,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
            {
                path: "/home/.wld/prompts/local.md",
                enabled: true,
                metadata: { source: "local", scope: "user", origin: "top-level" },
            },
        ],
    };
    const resources = filterEnabledPackagePrompts(resolved);

    assertEquals(getPackagePromptTemplatePaths(resources), ["/pkg/prompts/explain.md"]);
});

test("countPackageResourcesForSource separates package resource types", () => {
    const resolved: ResolvedPaths = {
        themes: [
            {
                path: "/pkg/themes/a.json",
                enabled: true,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
        ],
        prompts: [
            {
                path: "/pkg/prompts/a.md",
                enabled: true,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
            {
                path: "/pkg/prompts/b.md",
                enabled: true,
                metadata: { source: "npm:other", scope: "user", origin: "package" },
            },
        ],
        extensions: [
            {
                path: "/pkg/index.js",
                enabled: true,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
        ],
        skills: [
            {
                path: "/pkg/skills/a.md",
                enabled: true,
                metadata: { source: "npm:x", scope: "user", origin: "package" },
            },
        ],
    };

    assertEquals(countPackageResourcesForSource(resolved, "npm:x"), {
        themes: 1,
        prompts: 1,
        extensions: 1,
        skills: 1,
    });
});
