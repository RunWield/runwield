import { serveHttp, type HttpHandler } from "../../shared/http-server.ts";
import { createRemoteWorkspaceApp } from "../../ui/workspace/server.ts";
import { createRemoteWorkspaceAdapter } from "../../ui/workspace/server/remote-adapter.ts";

type RemoteWorkspaceAdapter = ReturnType<typeof createRemoteWorkspaceAdapter>;

export interface CollaborationServerFixture {
    adapter: RemoteWorkspaceAdapter;
    serverUrl: string;
}

export async function withCollaborationServer<Result>(
    run: (fixture: CollaborationServerFixture) => Promise<Result>,
    handle?: (request: Request, serve: HttpHandler) => Response | Promise<Response>,
): Promise<Result> {
    const app = createRemoteWorkspaceApp({ mode: "remote" });
    const adapter = app.adapter;
    const handler = app.handler();
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) =>
        handle ? handle(request, handler) : handler(request),
    );
    const address = server.addr;
    if (address.transport !== "tcp") {
        await server.shutdown();
        adapter.close();
        throw new Error("Collaboration test server did not bind a TCP address.");
    }

    try {
        return await run({ adapter, serverUrl: `http://${address.hostname}:${address.port}` });
    } finally {
        await server.shutdown();
        adapter.close();
    }
}
