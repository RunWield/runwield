/** Exercise synchronous remote persistence inside the production executable, not a source launcher. */
import { readFileSync } from "node:fs";
import { RemoteSessionSaveBridge } from "../../shared/remote/session-save-bridge.ts";
import type { RemoteSessionConnection } from "../../shared/remote/session-protocol.ts";

interface SaveCheckInput {
    connection: RemoteSessionConnection;
    contents: string;
}

export function checkPackagedRemoteSessionSave(): void {
    // Credentials travel through stdin, never command arguments or qualification output.
    const input: SaveCheckInput = JSON.parse(readFileSync(0, "utf8"));
    const bridge = new RemoteSessionSaveBridge(input.connection);
    try {
        bridge.request("hydrate");
        bridge.request("append", input.contents);
        bridge.request("checkpoint");
    } finally {
        bridge.close();
    }
}
