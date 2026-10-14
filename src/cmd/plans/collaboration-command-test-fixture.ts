import { serveHttp } from "../../shared/http-server.ts";
import { createRemoteWorkspaceApp } from "../../ui/workspace/server.js";
import { createRemoteWorkspaceAdapter } from "../../ui/workspace/server/remote-adapter.js";

type RemoteWorkspaceAdapter = ReturnType<typeof createRemoteWorkspaceAdapter>;

export interface CollaborationServerFixture {
    adapter: RemoteWorkspaceAdapter;
    serverUrl: string;
}

export async function withCollaborationServer(
    run: (fixture: CollaborationServerFixture) => Promise<void>,
): Promise<void> {
    const app = createRemoteWorkspaceApp({ mode: "remote" });
    const adapter = app.adapter;
    const handler = app.handler();
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
    const address = server.addr;
    if (address.transport !== "tcp") {
        await server.shutdown();
        adapter.close();
        throw new Error("Collaboration test server did not bind a TCP address.");
    }

    try {
        await run({ adapter, serverUrl: `http://${address.hostname}:${address.port}` });
    } finally {
        await server.shutdown();
        adapter.close();
    }
}
