import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    rm as fsRm,
    writeFile as fsWriteFile,
    rename as fsRename,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { listAllAgentDefinitions, loadAgentDef } from "./agents.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

import process from "node:process";

function definition(name: string, practices: string[]): string {
    return `---\nname: ${name}\nsharedPractice: ${JSON.stringify(practices)}\n---\n\nPERSONA_${name}\n`;
}

function fragment(body: string): string {
    return `---\nname: discovery-practice\n---\n\n${body}\n`;
}

async function withDiscoveryProject(run: (root: string, agentsDir: string) => Promise<void>): Promise<void> {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-agent-discovery-"));
    const agentsDir = join(root, ".wld", "agents");
    await fsMkdir(join(agentsDir, "shared-practice"), { recursive: true });
    try {
        await run(root, agentsDir);
    } finally {
        await fsRm(root, { recursive: true });
    }
}

test("one discovery shares a consistent practice body despite concurrent real resource edits", async () => {
    await withDiscoveryProject(async (root, agentsDir) => {
        const names = Array.from({ length: 48 }, (_, index) => `discovery-${String(index).padStart(2, "0")}`);
        for (const [index, name] of names.entries()) {
            await fsWriteFile(
                join(agentsDir, `${name}.md`),
                definition(name, index % 2 ? [" discovery-practice ", "discovery-practice"] : ["discovery-practice"]),
            );
        }
        const path = join(agentsDir, "shared-practice", "discovery-practice.md");
        await fsWriteFile(path, fragment("DISCOVERY_VERSION_0"));
        let finished = false;
        let edits = 0;
        const discovery = listAllAgentDefinitions(root).finally(() => (finished = true));
        // Atomic replacement gives each real read a complete valid fragment.
        // Keep editing until discovery ends; no mocked filesystem or timer race.
        while (!finished) {
            await fsWriteFile(`${path}.next`, fragment(`DISCOVERY_VERSION_${++edits}`));
            await fsRename(`${path}.next`, path);
        }
        const definitions = (await discovery).filter((agent) => names.includes(agent.name));
        assertEquals(definitions.length, names.length);
        assertEquals(edits > 1, true, "The fixture must edit during discovery");
        const versions = definitions.map((agent) => agent.systemPrompt.match(/DISCOVERY_VERSION_\d+/g));
        assertEquals(
            versions.every((matches) => matches?.length === 1),
            true,
        );
        assertEquals(new Set(versions.map((matches) => matches?.[0])).size, 1);
    });
});

test("the next discovery and individual loads observe direct edits to practices and definitions", async () => {
    await withDiscoveryProject(async (root, agentsDir) => {
        const name = "discovery-fresh";
        const agentPath = join(agentsDir, `${name}.md`);
        const practicePath = join(agentsDir, "shared-practice", "discovery-practice.md");
        await fsWriteFile(agentPath, definition(name, ["discovery-practice"]));
        await fsWriteFile(practicePath, fragment("FIRST_DISCOVERY_BODY"));
        const first = (await listAllAgentDefinitions(root)).find((agent) => agent.name === name)!;
        assertStringIncludes(first.systemPrompt, "FIRST_DISCOVERY_BODY");

        await fsWriteFile(practicePath, fragment("SECOND_DISCOVERY_BODY"));
        await fsWriteFile(agentPath, definition(name, ["discovery-practice"]).replace("PERSONA_", "EDITED_"));
        const second = (await listAllAgentDefinitions(root)).find((agent) => agent.name === name)!;
        assertStringIncludes(second.systemPrompt, "SECOND_DISCOVERY_BODY");
        assertStringIncludes(second.systemPrompt, `EDITED_${name}`);
        assertEquals(second.systemPrompt.includes("FIRST_DISCOVERY_BODY"), false);

        await fsWriteFile(practicePath, fragment("DIRECT_LOAD_BODY"));
        const direct = await loadAgentDef(name, root);
        assertStringIncludes(direct.systemPrompt, "DIRECT_LOAD_BODY");
        assertEquals(direct.systemPrompt.includes("SECOND_DISCOVERY_BODY"), false);
    });
});

test("discovery keeps distinct ordered shared-practice lists", async () => {
    await withDiscoveryProject(async (root, agentsDir) => {
        for (const [name, practices] of [
            ["discovery-forward", ["discovery-first", "discovery-second"]],
            ["discovery-reverse", ["discovery-second", "discovery-first"]],
        ] as const) {
            await fsWriteFile(join(agentsDir, `${name}.md`), definition(name, [...practices]));
        }
        await fsWriteFile(join(agentsDir, "shared-practice", "discovery-first.md"), fragment("FIRST_ORDER_MARKER"));
        await fsWriteFile(join(agentsDir, "shared-practice", "discovery-second.md"), fragment("SECOND_ORDER_MARKER"));
        const agents = await listAllAgentDefinitions(root);
        for (const name of ["discovery-forward", "discovery-reverse"]) {
            const prompt = agents.find((agent) => agent.name === name)!.systemPrompt;
            assertEquals(
                prompt.indexOf("FIRST_ORDER_MARKER") < prompt.indexOf("SECOND_ORDER_MARKER"),
                name === "discovery-forward",
            );
        }
    });
});

for (const existingAgentLayer of [false, true]) {
    test(`discovery excludes a newly created ${
        existingAgentLayer ? "practice directory" : "definition layer"
    } until the next call`, () =>
        withProcessGlobalTestLock(() =>
            withDiscoveryProject(async (root, agentsDir) => {
                const home = join(root, "home");
                const homeAgents = join(home, ".wld", "agents");
                await fsMkdir(existingAgentLayer ? homeAgents : home, { recursive: true });
                const previousHome = process.env["HOME"];
                const previousError = console.error;
                const boundaryName = "aaa-discovery-boundary";
                const name = "discovery-new-layer";
                await fsWriteFile(
                    join(agentsDir, `${boundaryName}.md`),
                    definition(boundaryName, []).replace("sharedPractice: []", "sharedPractice: invalid"),
                );
                await fsWriteFile(join(agentsDir, `${name}.md`), definition(name, ["discovery-practice"]));
                await fsWriteFile(
                    join(agentsDir, "shared-practice", "discovery-practice.md"),
                    fragment("PROJECT_LAYER_BODY"),
                );
                let created = false;
                process.env["HOME"] = home;
                // The malformed first definition supplies an observable boundary
                // after name discovery, before loading the remaining definitions.
                // Only the log sink is replaced; all resource operations are real.
                console.error = (...messages) => {
                    if (!String(messages[0]).includes(`Skipping agent "${boundaryName}"`)) {
                        previousError(...messages);
                        return;
                    }
                    mkdirSync(join(homeAgents, "shared-practice"), { recursive: true });
                    if (existingAgentLayer) {
                        // The bundled fragment remains the fallback until the
                        // next discovery sees the new home practice directory.
                        writeFileSync(
                            join(homeAgents, "shared-practice", "user-authority.md"),
                            fragment("NEW_HOME_PRACTICE"),
                        );
                    } else {
                        writeFileSync(
                            join(homeAgents, `${name}.md`),
                            definition(name, ["discovery-practice"]) + "NEW_HOME_DEFINITION\n",
                        );
                    }
                    created = true;
                };
                try {
                    if (existingAgentLayer) {
                        await fsWriteFile(join(agentsDir, `${name}.md`), definition(name, ["user-authority"]));
                    }
                    const first = (await listAllAgentDefinitions(root)).find((agent) => agent.name === name)!;
                    assertEquals(created, true);
                    assertEquals(first.systemPrompt.includes("NEW_HOME_"), false);
                    // Repair the malformed boundary so the next scan does not
                    // trigger another fixture update.
                    await fsWriteFile(join(agentsDir, `${boundaryName}.md`), definition(boundaryName, []));
                    const next = (await listAllAgentDefinitions(root)).find((agent) => agent.name === name)!;
                    assertStringIncludes(
                        next.systemPrompt,
                        existingAgentLayer ? "NEW_HOME_PRACTICE" : "NEW_HOME_DEFINITION",
                    );
                } finally {
                    console.error = previousError;
                    if (previousHome === undefined) delete process.env["HOME"];
                    else process.env["HOME"] = previousHome;
                }
            }),
        ));
}

test("equivalent normalized practice declarations share the already read body", async () => {
    await withDiscoveryProject(async (root, agentsDir) => {
        const firstName = "aaa-discovery-first";
        const boundaryName = "aab-discovery-boundary";
        const secondName = "aac-discovery-second";
        await fsWriteFile(join(agentsDir, `${firstName}.md`), definition(firstName, ["discovery-practice"]));
        await fsWriteFile(
            join(agentsDir, `${boundaryName}.md`),
            definition(boundaryName, []).replace("sharedPractice: []", "sharedPractice: invalid"),
        );
        await fsWriteFile(
            join(agentsDir, `${secondName}.md`),
            definition(secondName, [" discovery-practice ", "discovery-practice"]),
        );
        const path = join(agentsDir, "shared-practice", "discovery-practice.md");
        await fsWriteFile(path, fragment("NORMALIZED_FIRST_BODY"));
        const previousError = console.error;
        let edited = false;
        console.error = (...messages) => {
            if (!String(messages[0]).includes(`Skipping agent "${boundaryName}"`)) {
                previousError(...messages);
                return;
            }
            // The error occurs between the two valid definitions. This makes
            // the resource edit deterministic without replacing file reads.
            writeFileSync(path, fragment("NORMALIZED_EDITED_BODY"));
            edited = true;
        };
        try {
            const agents = await listAllAgentDefinitions(root);
            assertEquals(edited, true);
            for (const name of [firstName, secondName]) {
                const prompt = agents.find((agent) => agent.name === name)!.systemPrompt;
                assertStringIncludes(prompt, "NORMALIZED_FIRST_BODY");
                assertEquals(prompt.includes("NORMALIZED_EDITED_BODY"), false);
            }
        } finally {
            console.error = previousError;
        }
    });
});
