import process from "node:process";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";

// Executable ACP fixture. No provider or credentials are contacted.
interface Packet {
    id: number;
    method: string;
    params?: { configId?: string; value?: string; prompt?: { text: string }[]; mcpServers?: string[] };
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
const mode = process.env["RUNWIELD_IMAGE_FIXTURE_MODE"] || "success";
const args = process.argv.slice(2);
const cwd = process.cwd();
const marker = process.env["RUNWIELD_IMAGE_FIXTURE_ARGS"];
if (marker) {
    await writeFile(marker, JSON.stringify(args));
    await appendFile(marker + ".spawns", "spawn\n");
}
if (args[0] !== "acp" || args.includes("-p") || args.includes("--dangerously-skip-permissions")) process.exit(3);
const agent = args[args.indexOf("--agent") + 1];
const definition = await readFile(join(cwd, ".agents", "agents", agent, "agent.md"), "utf8");
if (!definition.includes("tools: [generate_image]") || !definition.includes("inheritMcp: false")) process.exit(4);
let model = "";
let effort = "low";
let promptId = 0;
function update(value: {
    sessionUpdate: string;
    toolCallId?: string;
    name?: string;
    status?: string;
    content?: { type: string; text: string };
}) {
    console.log(
        JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "image-fixture", update: value },
        }),
    );
}
for await (const line of createInterface({ input: process.stdin })) {
    const packet = JSON.parse(line) as Packet;
    const reply = (result: {
        protocolVersion?: number;
        sessionId?: string;
        stopReason?: string;
        configOptions?: { id: string; currentValue: string }[];
    }) => console.log(JSON.stringify({ jsonrpc: "2.0", id: packet.id, result }));
    if (packet.method === "initialize") reply({ protocolVersion: 1 });
    else if (packet.method === "session/new") {
        if (packet.params?.mcpServers?.length) process.exit(5);
        reply({ sessionId: "image-fixture", configOptions: [{ id: "mode", currentValue: "default" }] });
    } else if (packet.method === "session/set_config_option") {
        if (packet.params?.configId === "model") model = packet.params.value || "";
        if (packet.params?.configId === "thought_level") effort = packet.params.value || "";
        reply({
            configOptions: [
                { id: "model", currentValue: mode === "mismatch" ? "wrong-model" : model },
                { id: "thought_level", currentValue: effort },
            ],
        });
    } else if (packet.method === "session/prompt") {
        promptId = packet.id;
        const prompt = packet.params?.prompt?.map((item) => item.text).join("\n") || "";
        const referenceMatch = prompt.match(/reference paths as ImagePaths: (\[.*\])\./);
        const referencePaths = referenceMatch ? (JSON.parse(referenceMatch[1]) as string[]) : [];
        const referenceData = await Promise.all(
            referencePaths.map(async (path) => (await readFile(path)).toString("base64")),
        );
        if (marker)
            await writeFile(
                marker + ".turn",
                JSON.stringify({ model, effort, prompt: packet.params?.prompt, referencePaths, referenceData, cwd }),
            );
        if (mode === "wait") continue;
        let path = join(cwd, mode === "mime-mismatch" ? "generated.jpg" : "generated.png");
        if (mode === "session") {
            const directory = join(process.env["HOME"] || "", ".gemini", "antigravity-cli", "brain", "image-fixture");
            await mkdir(directory, { recursive: true });
            path = join(directory, "generated.png");
        }
        await writeFile(path, mode === "invalid" ? "not an image" : Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
        if (mode === "outside") path = process.env["RUNWIELD_IMAGE_FIXTURE_OUTSIDE"] || "/other/image.png";
        if (mode === "symlink") {
            const linked = join(cwd, "escape.png");
            await symlink(process.env["RUNWIELD_IMAGE_FIXTURE_OUTSIDE"] || "/other/image.png", linked);
            path = linked;
        }
        if (mode !== "text-only")
            update({
                sessionUpdate: "tool_call_update",
                toolCallId: "image-1",
                name: "generate_image",
                status: mode === "false-success" ? "failed" : "completed",
            });
        if (mode === "multiple")
            update({
                sessionUpdate: "tool_call_update",
                toolCallId: "image-2",
                name: "generate_image",
                status: "completed",
            });
        const text =
            mode === "malformed"
                ? "Saved your image!"
                : mode === "extras"
                  ? JSON.stringify({ path, extra: true })
                  : JSON.stringify({ path });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        reply({ stopReason: "end_turn" });
    } else if (packet.method === "session/cancel") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } }));
    } else if (packet.method === "session/close") reply({});
}
