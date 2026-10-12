/** Native Bun request/response HTTP serving. */
import { versions } from "node:process";

export interface HttpAddress {
    transport: "tcp" | "udp";
    hostname: string;
    port: number;
}
export interface HttpServer {
    readonly addr: HttpAddress;
    readonly finished: Promise<void>;
    shutdown(): Promise<void>;
    ref(): void;
    unref(): void;
    [Symbol.asyncDispose](): PromiseLike<void>;
}
export interface HttpServerOptions {
    hostname: string;
    port: number;
    signal?: AbortSignal;
    automaticCompression?: boolean;
    onListen?(address: HttpAddress): void;
    onError?(error: Error): Response | Promise<Response>;
}
export type HttpHandler = (request: Request) => Response | Promise<Response>;
interface BunHttpServer {
    hostname: string;
    port: number;
    stop(force?: boolean): Promise<void>;
    ref(): void;
    unref(): void;
}
interface BunHttpOptions {
    hostname: string;
    port: number;
    idleTimeout: number;
    fetch: HttpHandler;
    error?(error: Error): Response | Promise<Response>;
}
interface BunHttpRuntime {
    serve(options: BunHttpOptions): BunHttpServer;
}

function acceptsGzip(header: string): boolean {
    let wildcard = false;
    for (const item of header.toLowerCase().split(",")) {
        const [encoding, ...parameters] = item.trim().split(";");
        const quality = parameters.map((part) => part.trim()).find((part) => part.startsWith("q="));
        const accepted = quality === undefined || Number(quality.slice(2)) > 0;
        if (encoding === "gzip") return accepted;
        if (encoding === "*") wildcard = accepted;
    }
    return wildcard;
}

function compressResponse(request: Request, response: Response): Response {
    const type = response.headers.get("content-type") || "";
    if (
        request.method === "HEAD" ||
        !response.body ||
        response.status === 206 ||
        response.headers.has("content-encoding") ||
        /\bno-transform\b/i.test(response.headers.get("cache-control") || "") ||
        type.startsWith("text/event-stream") ||
        !/^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i.test(type) ||
        !acceptsGzip(request.headers.get("accept-encoding") || "")
    )
        return response;
    const headers = new Headers(response.headers);
    headers.set("content-encoding", "gzip");
    headers.delete("content-length");
    const vary = headers.get("vary");
    if (!vary?.split(",").some((field) => ["accept-encoding", "*"].includes(field.trim().toLowerCase()))) {
        headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    }
    const etag = headers.get("etag");
    if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
    return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export function serveHttp(options: HttpServerOptions, handler: HttpHandler): HttpServer {
    if (!versions.bun) throw new Error("HTTP serving requires Bun");
    const bun = Reflect.get(globalThis, "Bun") as BunHttpRuntime;
    const server = bun.serve({
        hostname: options.hostname,
        port: options.port,
        // Workspace has long-running streams; client/owner lifecycles cancel
        // them explicitly, rather than Bun's short default idle timeout.
        idleTimeout: 0,
        fetch: options.automaticCompression
            ? async (request) => compressResponse(request, await handler(request))
            : handler,
        error:
            options.onError ||
            ((error) => {
                console.error(error);
                return new Response("Internal Server Error", { status: 500 });
            }),
    });
    let resolveFinished!: () => void;
    let rejectFinished!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
    });
    let stopping: Promise<void> | undefined;
    function stop(force: boolean): Promise<void> {
        if (stopping && force) void server.stop(true).catch(() => {});
        if (!stopping) {
            stopping = server
                .stop(force)
                .then(resolveFinished, (error: Error) => {
                    rejectFinished(error);
                    throw error;
                })
                .finally(() => options.signal?.removeEventListener("abort", abort));
        }
        return stopping;
    }
    function abort() {
        void stop(true).catch(() => {});
    }
    const addr: HttpAddress = { transport: "tcp", hostname: server.hostname, port: server.port };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    queueMicrotask(() => options.onListen?.(addr));
    return {
        addr,
        finished,
        shutdown: () => stop(false),
        ref: () => server.ref(),
        unref: () => server.unref(),
        [Symbol.asyncDispose]: () => stop(false),
    };
}
