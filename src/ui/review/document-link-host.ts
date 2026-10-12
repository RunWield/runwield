/** Lazy, TUI-owned loopback reader for Project-relative Markdown mentions. */
import { extname } from "node:path";
import { PLAN_UI_TOKEN_QUERY } from "../../constants.js";
import { createDocumentReadWorkspaceApp } from "../workspace/server.js";
import { resolveWorkspaceFile } from "../workspace/routes/api/review-file-handlers.ts";

type DocumentRequestHandler = (request: Request) => Promise<Response>;

export class DocumentLinkHost {
    #root: string | null = null;
    #token = "";
    #handler: DocumentRequestHandler | null = null;
    #server: Deno.HttpServer<Deno.NetAddr> | null = null;
    #disposed = false;
    #disposePromise: Promise<void> | null = null;

    constructor(projectRoot: string) {
        this.rebind(projectRoot);
    }

    /** Rotate even for the same root so links from the prior Session fail closed. */
    rebind(projectRoot: string): void {
        if (this.#disposed) return;
        this.#token = crypto.randomUUID();
        try {
            this.#root = Deno.realPathSync(projectRoot);
            if (!Deno.statSync(this.#root).isDirectory) this.#root = null;
        } catch {
            this.#root = null;
        }
        this.#handler = this.#root
            ? createDocumentReadWorkspaceApp({ cwd: this.#root, token: this.#token }).handler()
            : null;
    }

    /** Validate without starting a listener for missing or unsafe mentions. */
    resolve(path: string, representation: "markdown" | "literal" = "markdown"): string | null {
        if (this.#disposed || !this.#root) return null;
        try {
            const hashIndex = path.indexOf("#");
            const fragment = hashIndex < 0 ? "" : path.slice(hashIndex);
            const value = hashIndex < 0 ? path : path.slice(0, hashIndex);
            const filePath = representation === "literal" ? value : decodeURIComponent(value);
            if (extname(filePath).toLowerCase() !== ".md") return null;
            const file = resolveWorkspaceFile(this.#root, filePath);
            if (!file || extname(file.absolutePath).toLowerCase() !== ".md") return null;
            if (!this.#server) {
                this.#server = Deno.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    onListen() {},
                    onError: () =>
                        new Response("Unable to read document.", {
                            status: 500,
                            headers: { "cache-control": "no-store" },
                        }),
                }, (request) => {
                    if (this.#disposed || !this.#handler) {
                        return new Response("Document token required.", {
                            status: 401,
                            headers: { "cache-control": "no-store" },
                        });
                    }
                    return this.#handler(request);
                });
            }
            const url = new URL(`http://127.0.0.1:${this.#server.addr.port}/review/plan`);
            url.searchParams.set(PLAN_UI_TOKEN_QUERY, this.#token);
            url.searchParams.set("path", file.path);
            url.hash = fragment;
            return url.href;
        } catch {
            // A malformed mention or unavailable filesystem is plain text, not a TUI failure.
            return null;
        }
    }

    /** Revoke access immediately; all callers share the same shutdown completion. */
    async dispose(): Promise<void> {
        this.#disposed = true;
        this.#handler = null;
        this.#root = null;
        this.#token = "";
        this.#disposePromise ??= this.#server ? this.#server.shutdown() : Promise.resolve();
        await this.#disposePromise;
    }
}
