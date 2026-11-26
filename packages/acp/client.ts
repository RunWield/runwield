import { client, ndJsonStream, type ClientApp, type ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AcpTransport } from "./transport.ts";

export type { AcpTransport } from "./transport.ts";

/** The host's transport, client name and optional request handlers for one ACP connection. */
export interface AcpClientOptions {
    transport: AcpTransport;
    name?: string;
    /** Register handlers before the connection starts reading protocol frames. */
    configure?(app: ClientApp): void;
}

/**
 * Register client handlers and connect over the caller's newline-delimited JSON transport.
 * The caller owns the underlying transport's lifetime.
 */
export function connectAcpClient({ transport, name, configure }: AcpClientOptions): ClientConnection {
    const app = client({ name });
    configure?.(app);
    return app.connect(ndJsonStream(transport.writable, transport.readable));
}
