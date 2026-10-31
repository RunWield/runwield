/** Real remote manager and Worker. Only the vision model completion is synthetic. */
import { rmSync } from "node:fs";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { assertEquals } from "../../testing/assertions.ts";
import type { RemoteSessionSaveBridge } from "./session-save-bridge.ts";
import type { RemoteSessionConnection } from "./session-protocol.ts";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import { createRemoteRootSessionManager, getRemoteSessionSaveBridge } from "../session/root-session.js";
import { persistImageAttachment, readImageRef, resolveImageRef } from "../session/image-attachments.ts";
import { createSeeImageTool } from "../../tools/see-image.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

interface Input {
    connection: RemoteSessionConnection;
    cwd: string;
    mount: string;
    mode: "upload" | "read" | "fault";
    ref?: string;
}
const input: Input = JSON.parse(await new Response(stdinStream()).text());
configureRemotePersonalResources({ globalRoot: input.mount });
// No mounted data or root remains available for attachment reads.
rmSync(input.mount, { recursive: true, force: true });
let bridge: RemoteSessionSaveBridge | undefined;
try {
    const manager = await createRemoteRootSessionManager(input.cwd, input.connection);
    bridge = getRemoteSessionSaveBridge(manager)!;
    if (input.mode === "fault") {
        let failed = false;
        try {
            await readImageRef(input.ref ?? "", { cwd: input.cwd, sessionManager: manager });
        } catch {
            failed = true;
        }
        let stopped = false;
        try {
            manager.getEntries();
        } catch {
            stopped = true;
        }
        console.log(JSON.stringify({ failed, stopped, aborted: bridge.signal.aborted }));
    } else {
        const image =
            input.mode === "upload"
                ? await persistImageAttachment({ base64: "AQIDBA==", mimeType: "image/png" }, manager, input.cwd)
                : await readImageRef(input.ref ?? "", { cwd: input.cwd, sessionManager: manager });
        if (input.mode === "upload") manager.appendCustomEntry("runwield.image", image);
        const attachment = await readImageRef(image.ref ?? "", { cwd: input.cwd, sessionManager: manager });
        let pathDenied = false;
        try {
            await resolveImageRef(image.ref ?? "", { cwd: input.cwd, sessionManager: manager });
        } catch {
            pathDenied = true;
        }
        const images: string[] = [];
        const tool = createSeeImageTool({
            cwd: input.cwd,
            sessionManager: manager,
            remoteModel: {
                provider: "verification",
                id: "vision",
                name: "Vision",
                api: "openai-completions",
                baseUrl: "https://verification.invalid",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 2048,
            },
            completeSimpleFn: (_model, context) => {
                for (const message of context.messages) {
                    if (message.role === "user" && Array.isArray(message.content)) {
                        for (const block of message.content) {
                            if (block.type === "image") images.push(`${block.mimeType}:${block.data}`);
                        }
                    }
                }
                return Promise.resolve(fauxAssistantMessage(fauxText("Image described.")));
            },
        });
        // The tool does not use ExtensionToolContext. Match the existing local tool test invocation.
        const result = await Reflect.apply(tool.execute, tool, [
            "vision",
            { imageRef: image.ref },
            undefined,
            undefined,
            {},
        ]);
        assertEquals(result.details, { ok: true });
        const local = await readImageRef("project.png", { cwd: input.cwd, sessionManager: manager });
        const localResult = await Reflect.apply(tool.execute, tool, [
            "local",
            { imageRef: "project.png" },
            undefined,
            undefined,
            {},
        ]);
        assertEquals(localResult.details, { ok: true });
        bridge.request("checkpoint");
        console.log(JSON.stringify({ attachment, local, images, pathDenied, file: manager.getSessionFile() ?? null }));
    }
} finally {
    bridge?.close();
}
