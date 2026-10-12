import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { DocumentLinkHost } from "../review/document-link-host.ts";
import { initRunWieldTheme } from "../theme/theme.js";
import { AgentMessageBlock, SystemMessageBlock, ToolExecutionBlock, UserPromptBlock } from "./blocks.js";

initRunWieldTheme();

async function withDocuments(run: (host: DocumentLinkHost) => void | Promise<void>) {
    const root = await Deno.makeTempDir({ prefix: "tui-document-mentions-" });
    const host = new DocumentLinkHost(root);
    const capabilities = getCapabilities();
    setCapabilities({ ...capabilities, hyperlinks: true });
    try {
        await Deno.mkdir(`${root}/docs`);
        for (const name of ["file.md", "café.md", "with space.md", "100%.md", "literal%20name.md", "literal name.md"]) {
            await Deno.writeTextFile(`${root}/docs/${name}`, `# ${name}\nCurrent content`);
        }
        await Deno.writeTextFile(`${root}/README.md`, "# Home");
        await run(host);
    } finally {
        setCapabilities(capabilities);
        await host.dispose();
        await Deno.remove(root, { recursive: true });
    }
}

function targets(text: string): string[] {
    // deno-lint-ignore no-control-regex
    return Array.from(text.matchAll(/\x1b\]8;;(http:\/\/127\.0\.0\.1:[^\x07]+)\x07/g), (match) => match[1]);
}

Deno.test("Agent mentions keep labels and resolve all Markdown shapes through a real reader", async () => {
    await withDocuments(async (host) => {
        const examples = [
            ["(docs/file.md)", "(docs/file.md)", "docs/file.md"],
            ["`docs/file.md`", "docs/file.md", "docs/file.md"],
            ["[Read the document](docs/file.md)", "Read the document", "docs/file.md"],
            ["README.md", "README.md", "README.md"],
            ["See docs/café.md.", "See docs/café.md.", "docs/café.md"],
            ["docs/caf%C3%A9.md", "docs/caf%C3%A9.md", "docs/café.md"],
            ["`docs/with space.md`", "docs/with space.md", "docs/with space.md"],
            ["docs/file.md#details", "docs/file.md#details", "docs/file.md"],
            ["docs/file.md#details.", "docs/file.md#details.", "docs/file.md"],
            ["`docs/100%.md`", "docs/100%.md", "docs/100%.md"],
            ["`docs/literal%20name.md`", "docs/literal%20name.md", "docs/literal%20name.md"],
            ["[Encoded](docs/literal%20name.md)", "Encoded", "docs/literal name.md"],
            ["[(docs/file.md)](docs/file.md)", "(docs/file.md)", "docs/file.md"],
        ];
        const urls = [];
        for (const [source, label, path] of examples) {
            const block = new AgentMessageBlock("Guide", host);
            block.appendText(source);
            const rendered = block.render(120).join("\n");
            assertStringIncludes(stripAnsi(rendered), label);
            assertEquals(targets(rendered).length, 1, source);
            const url = targets(rendered)[0];
            assertEquals(new URL(url).searchParams.get("path"), path);
            if (source.includes("#details")) assertEquals(new URL(url).hash, "#details");
            assertEquals(block.currentText, source);
            assertEquals(block.render(120).join("\n"), rendered);
            urls.push(url);
        }
        const responses = await Promise.all(urls.map((url) => fetch(url)));
        for (const response of responses) {
            assertEquals(response.status, 200);
            assertStringIncludes(await response.text(), "artifact-read");
        }
    });
});

Deno.test("Agent document links wrap lists and repeat without duplicated punctuation", async () => {
    await withDocuments((host) => {
        const block = new AgentMessageBlock("", host);
        block.appendText("- Read (docs/file.md), then README.md!\n- Again docs/file.md.");
        const rendered = block.render(30);
        assert(rendered.every((line) => visibleWidth(line) <= 30));
        const output = rendered.join("\n");
        const plain = stripAnsi(output).replace(/\s+/g, " ").trim();
        assertStringIncludes(plain, "Read (docs/file.md), then README.md!");
        assertStringIncludes(plain, "Again docs/file.md.");
        assertEquals(new Set(targets(output)).size, 2);
    });
});

Deno.test("streamed partial mentions become links only when the path is complete", async () => {
    await withDocuments((host) => {
        const block = new AgentMessageBlock("", host);
        block.appendText("(docs/file.m");
        assertEquals(targets(block.render(100).join("\n")), []);
        block.appendText("d");
        assertEquals(targets(block.render(100).join("\n")).length, 1);
        block.appendText(").");
        assertStringIncludes(stripAnsi(block.render(100).join("\n")), "(docs/file.md).");
        assertEquals(targets(block.render(100).join("\n")).length, 1);
    });
});

Deno.test("code, images, external and incomplete paths never gain local reader targets", async () => {
    await withDocuments((host) => {
        for (
            const text of [
                "```\nREADME.md\n```",
                "    docs/file.md",
                "![docs/file.md](docs/file.md)",
                "https://example.org/docs/file.md",
                "http://example.org/README.md",
                "[mail](mailto:README.md)",
                "[file](file:README.md)",
                "[section](#details)",
                "src/file.ts",
                "missing.md",
                "README.md\\_backup",
                "README.md*backup*",
                "docs/file.md.txt",
                "docs/file.md:12",
                "`read docs/file.md please`",
                "docs/file.m",
            ]
        ) {
            const block = new AgentMessageBlock("", host);
            block.appendText(text);
            assertEquals(targets(block.render(120).join("\n")), [], text);
        }
    });
});

for (const markers of ["**", "*", "~~", "***", "**~~"]) {
    const closing = markers === "**~~" ? "~~**" : markers;
    Deno.test(`Agent mentions respect visible word boundaries across ${markers} formatting`, async () => {
        await withDocuments((host) => {
            for (
                const source of [
                    `${markers}README.md${closing}.txt`,
                    `prefix${markers}README.md${closing}`,
                    `${markers}README.md${closing}backup`,
                    `${markers}README.md.${closing}txt`,
                    `${markers}README.md${closing}.${markers}txt${closing}`,
                ]
            ) {
                const block = new AgentMessageBlock("", host);
                const baseline = new AgentMessageBlock("", null);
                block.appendText(source);
                baseline.appendText(source);
                assertEquals(block.render(120), baseline.render(120), source);
                assertEquals(targets(block.render(120).join("\n")), [], source);
            }
            for (
                const source of [
                    `(${markers}README.md${closing}).`,
                    `Read ${markers}README.md${closing}. Next`,
                    `prefix${markers} read README.md please${closing}suffix`,
                ]
            ) {
                const block = new AgentMessageBlock("", host);
                const baseline = new AgentMessageBlock("", null);
                block.appendText(source);
                baseline.appendText(source);
                const rendered = block.render(120).join("\n");
                assertEquals(stripAnsi(rendered), stripAnsi(baseline.render(120).join("\n")), source);
                assertEquals(targets(rendered).length, 1, source);
            }
        });
    });
}

Deno.test("no-hyperlink capability preserves fallback without starting reader URL output", async () => {
    await withDocuments((host) => {
        setCapabilities({ ...getCapabilities(), hyperlinks: false });
        for (const source of ["(docs/file.md)", "`docs/file.md`", "[Label](docs/file.md)"]) {
            const linked = new AgentMessageBlock("", host);
            const baseline = new AgentMessageBlock("", null);
            linked.appendText(source);
            baseline.appendText(source);
            assertEquals(linked.render(100), baseline.render(100));
            const output = linked.render(100).join("\n");
            assert(!output.includes("127.0.0.1") && !output.includes("token=") && !output.includes("file://"));
        }
    });
});

Deno.test("User, system and tool blocks remain plain document text", async () => {
    await withDocuments(() => {
        const user = new UserPromptBlock("README.md");
        const system = new SystemMessageBlock("README.md");
        const tool = new ToolExecutionBlock("read", "README.md");
        tool.setOutput("README.md");
        for (const block of [user, system, tool]) {
            const rendered = block.render(100).join("\n");
            assertStringIncludes(stripAnsi(rendered), "README.md");
            assertEquals(targets(rendered), []);
        }
    });
});
