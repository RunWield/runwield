import { readFile as fsReadFile, utimes as fsUtimes, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import { getCwd } from "../../../constants.js";

interface Request {
    id?: number;
    method: string;
    params?: { model?: string; threadId?: string; input?: { text?: string }[]; effort?: string };
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";

async function main() {
    const mode = process.env["RUNWIELD_CODEX_IMAGE_MODE"] || "success";
    const log = process.env["RUNWIELD_CODEX_IMAGE_LOG"];
    const startGate = process.env["RUNWIELD_CODEX_IMAGE_START_GATE"];
    const pidPath = process.env["RUNWIELD_CODEX_IMAGE_PID"];
    if (pidPath) await fsWriteFile(pidPath, String(process.pid));
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of process.stdin) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const request = JSON.parse(buffer.slice(0, newline)) as Request;
            buffer = buffer.slice(newline + 1);
            if (log) await fsWriteFile(log, `${JSON.stringify(request)}\n`, { flag: "a" });
            const respond = <T>(result: T) => console.log(JSON.stringify({ id: request.id, result }));
            switch (request.method) {
                case "initialize":
                    respond({});
                    break;
                case "account/read":
                    respond({ account: { type: mode === "api-key" ? "apiKey" : "chatgpt" } });
                    break;
                case "modelProvider/capabilities/read":
                    respond({ imageGeneration: mode !== "unsupported" });
                    break;
                case "model/list":
                    respond({
                        data: [
                            {
                                id: "fixture-model",
                                model: "fixture-model",
                                supportedReasoningEfforts: [{ reasoningEffort: "low" }],
                            },
                        ],
                        nextCursor: null,
                    });
                    break;
                case "thread/start":
                    respond({ thread: { id: "thread-fixture" } });
                    break;
                case "turn/start": {
                    if (mode === "unacknowledged") break;
                    if (startGate) {
                        while (!(await fsReadFile(startGate, "utf8").catch(() => ""))) {
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                    }
                    respond({ turn: { id: "turn-fixture", status: "inProgress" } });
                    if (mode === "wait") break;
                    if (mode === "approval") {
                        console.log(
                            JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }),
                        );
                        break;
                    }
                    if (mode === "malformed") {
                        console.log("not json");
                        break;
                    }
                    if (mode === "exit") process.exit(1);
                    const path = `${getCwd()}/image.png`;
                    await fsWriteFile(
                        path,
                        Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)),
                    );
                    if (mode === "stale") await fsUtimes(path, 1, 1);
                    const item = {
                        id: "image-fixture",
                        type: "imageGeneration",
                        status: mode === "failed-image" ? "failed" : "completed",
                        savedPath: mode === "outside" ? process.env["RUNWIELD_CODEX_IMAGE_OUTSIDE"] : path,
                        failure: null,
                        result: "fixture",
                    };
                    const items =
                        mode === "no-image" ? [] : mode === "multiple" ? [item, { ...item, id: "image-two" }] : [item];
                    for (const image of items) {
                        console.log(
                            JSON.stringify({
                                method: "item/completed",
                                params: {
                                    threadId: "thread-fixture",
                                    turnId: mode === "wrong-turn" ? "other-turn" : "turn-fixture",
                                    item: image,
                                },
                            }),
                        );
                    }
                    console.log(
                        JSON.stringify({
                            method: "turn/completed",
                            params: {
                                threadId: "thread-fixture",
                                turn: {
                                    id: "turn-fixture",
                                    status: mode === "failed-turn" ? "failed" : "completed",
                                    items: [],
                                },
                            },
                        }),
                    );
                    break;
                }
                case "turn/interrupt":
                    respond({});
                    break;
            }
        }
    }
}
if (import.meta.main) await main();
