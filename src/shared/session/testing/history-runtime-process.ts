/** File-authority fixture process. It does not load a model or an Agent. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCwd } from "../../../constants.js";
import { getRunWieldSessionDir } from "../root-session.js";
import { openOwnerCoordinationStore } from "../../owner-coordination/index.ts";
import { stableHash } from "../session-continuation-service.ts";

async function main() {
    const store = openOwnerCoordinationStore();
    const [action, identity] = process.argv.slice(2);
    try {
        if (action === "seed") {
            const cwd = getCwd();
            const directory = getRunWieldSessionDir(cwd);
            await mkdir(directory, { recursive: true });
            const timestamp = "2026-01-01T00:00:00.000Z";
            const piSessionId = crypto.randomUUID();
            const transcriptPath = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
            const entries = [
                { type: "session", version: 3, id: piSessionId, timestamp, cwd },
                {
                    type: "message",
                    id: "seed-user",
                    parentId: null,
                    timestamp,
                    message: { role: "user", content: "Provider-independent bootstrap." },
                },
                {
                    type: "message",
                    id: "seed-answer",
                    parentId: "seed-user",
                    timestamp,
                    message: { role: "assistant", content: [{ type: "text", text: "Saved without a model." }] },
                },
            ];
            for (let index = 0; index < Number(process.argv[4] || 0); index++) {
                entries.push({
                    type: "message",
                    id: `history-${index}`,
                    parentId: index ? `history-${index - 1}` : "seed-answer",
                    timestamp,
                    message: {
                        role: index % 2 ? "assistant" : "user",
                        content: [{ type: "text", text: `History message ${index}.` }],
                    },
                });
            }
            await writeFile(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
            const session = await store.ensureSessionCatalogRecord({
                projectId: identity,
                piSessionId,
                transcriptPath,
                transcriptCwd: cwd,
                source: "catalog",
            });
            console.log(JSON.stringify({ sessionId: session.runwieldSessionId, transcriptPath }));
        } else if (action === "orphan-receipt") {
            const session = store.getSessionById(identity)!;
            const generation = store.inspectSessionActivation(identity).generation!.generation;
            const receipt = store.createOrGetOperationReceipt({
                projectId: session.projectId,
                runwieldSessionId: identity,
                requestId: "lost-receipt",
                requestHash: stableHash({
                    kind: "continuation",
                    session: identity,
                    expectedGeneration: generation,
                    text: "Keep uncertain draft.",
                    images: [],
                }),
                expectedGeneration: generation,
                kind: "continuation",
            })!;
            store.updateOperationReceipt(receipt.operationId, { status: "running" });
            console.log(receipt.operationId);
        } else if (action === "inspect") {
            console.log(JSON.stringify(store.inspectSessionActivation(identity)));
        } else if (action === "hold") {
            const session = store.getSessionById(identity)!;
            const proof = store.acquireSessionActivation({
                runwieldSessionId: identity,
                projectId: session.projectId,
                ownerInstanceId: "history-conflicting-writer",
                ownerProcessKind: "tui",
                phase: "bootstrap",
            });
            console.log(JSON.stringify(proof));
            for await (const _chunk of process.stdin) break;
            store.releaseUnchangedActivation(proof);
        } else throw new Error("Unsupported history fixture command.");
    } finally {
        store.close();
    }
}
await main();
