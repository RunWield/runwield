/** A real laptop owner in a separate process. The debugger supplies a stop barrier, not a machinery seam. */
import { LaptopSessionControl, type LaptopSessionTarget } from "./laptop-session-control.ts";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";

declare global {
    var rolloverControl: LaptopSessionControl;
}
interface OwnerInput {
    target: LaptopSessionTarget;
    sessionId: string;
}
const lines = processLines(stdinStream());
const input: OwnerInput = JSON.parse((await lines.read()).value || "{}");
const control = new LaptopSessionControl(input.target);
globalThis.rolloverControl = control;
const admitted = await control.handle({ kind: "begin", sessionId: input.sessionId, admissionId: crypto.randomUUID() });
const operation = admitted.operation!;
await control.handleSave({ kind: "hydrate", operation, sequence: 0, contents: "" });
console.log(JSON.stringify({ operation }));
for (;;) {
    const next = await lines.read();
    if (next.done) break;
    if (next.value === "rollover") {
        try {
            const response = await control.handleSave({
                kind: "rollover",
                operation,
                sequence: 1,
                contents: JSON.stringify({ kind: "execution", continuation: null }),
            });
            console.log(JSON.stringify({ ok: true, response }));
        } catch (error) {
            console.log(JSON.stringify({ ok: false, error: String(error) }));
        }
    } else if (next.value === "close") break;
}
control.close();
await lines.cancel();
