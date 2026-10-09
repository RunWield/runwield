import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { writeSearchIndex } from "./src/search-index.ts";
import release from "./release.json" with { type: "json" };

const preview = release.version === "Preview";

export default defineConfig({
    site: "https://docs.runwield.dev",
    outDir: "../dist/docs",
    integrations: [
        withAwaitedSearchWrites(starlight({
            title: "RunWield Docs",
            description: "Install, use, and configure RunWield.",
            logo: { src: "./src/assets/logo.svg" },
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/gandazgul/runwield",
                },
            ],
            customCss: ["./src/styles/runwield.css"],
            components: { Head: "./src/components/Head.astro" },
            editLink: {
                baseUrl: "https://github.com/gandazgul/runwield/edit/docs/stable/docs/",
            },
            head: [
                { tag: "meta", attrs: { name: "theme-color", content: "#0b1020" } },
                {
                    tag: "link",
                    attrs: { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
                },
            ],
            sidebar: [
                { label: "Home", link: "/" },
                {
                    label: "RunWield.dev",
                    link: "https://runwield.dev",
                    attrs: {
                        class: "external-link",
                        "aria-label": "RunWield.dev (external link)",
                    },
                },
                { label: "Start", items: ["quickstart", "workspace"] },
                {
                    label: "Use RunWield",
                    items: ["usage", "workflows", "sessions", "collaboration"],
                },
                {
                    label: "Configure",
                    items: ["providers", "settings", "customization", "themes", "mcp"],
                },
                { label: "Help", items: ["troubleshooting"] },
                {
                    label: "Contributing",
                    collapsed: true,
                    items: [
                        "contributing",
                        "contributing/plan-lifecycle",
                        "contributing/validation-authority",
                        {
                            label: "Product requirements",
                            items: [
                                "contributing/prd/runwield",
                                "contributing/prd/runwield-core-prd",
                                "contributing/prd/runwield-workspace-prd",
                                "contributing/prd/runwield-connect-prd",
                                "contributing/prd/runwield-acp-protocol-prd",
                            ],
                        },
                    ],
                },
                {
                    label: preview ? "Preview documentation" : `Stable ${release.version}`,
                    link: release.releaseUrl,
                },
            ],
        })),
    ],
});

/** @param {import("astro").AstroIntegration} integration */
function withAwaitedSearchWrites(integration) {
    // Keep Starlight's search UI, replacing only its build hook. Pagefind 1.5.2
    // returns from writeFiles before Tokio flushes; close() then kills the writer.
    integration.hooks["astro:build:done"] = writeSearchIndex;
    return integration;
}
