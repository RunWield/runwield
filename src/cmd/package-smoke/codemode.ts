import {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Execute real local reads through Pi's tool pipeline in the packaged QuickJS worker. */
export async function checkPackagedCodemode(): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "runwield-codemode-package-"));
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [createCodemodeExtension()],
    });
    let session;
    try {
        await writeFile(join(cwd, "left.txt"), "20");
        await writeFile(join(cwd, "right.txt"), "22");
        await loader.reload();
        ({ session } = await createAgentSession({
            cwd,
            agentDir: cwd,
            settingsManager: SettingsManager.inMemory(),
            sessionManager: SessionManager.inMemory(cwd),
            resourceLoader: loader,
            tools: ["read", "codemode"],
        }));
        await session.bindExtensions({});
        session.setActiveToolsByName(["read", "codemode"]);
        const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
        if (!tool) throw new Error("Packaged codemode is unavailable");
        session.agent.state.messages = [
            ...session.agent.state.messages,
            fauxAssistantMessage({ type: "toolCall", id: "package-codemode", name: "codemode", arguments: {} }),
        ];
        const result = await tool.execute("package-codemode", {
            code: 'const values = await Promise.all([tools.read({path:"left.txt"}), tools.read({path:"right.txt"})]); text(values.map(Number).reduce((a,b)=>a+b,0));',
        });
        const text = result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
        if (!text.includes("Script completed") || !/\b42\b/.test(text))
            throw new Error(`Packaged codemode failed: ${text}`);
    } finally {
        session?.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
}

if (import.meta.main) await checkPackagedCodemode();
