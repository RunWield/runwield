/// <reference types="astro/client" />
/// <reference lib="deno.ns" />

// Astro's checker does not load Deno's standard library declarations.
declare namespace Deno {
    function realPathSync(path: string | URL): string;
    interface WorkspaceFileInfo {
        isFile: boolean;
    }

    interface WorkspaceMkdirOptions {
        recursive?: boolean;
    }

    function cwd(): string;
    function realPath(path: string | URL): Promise<string>;
    function stat(path: string | URL): Promise<WorkspaceFileInfo>;
    function mkdir(path: string | URL, options?: WorkspaceMkdirOptions): Promise<void>;
    function readFile(path: string | URL): Promise<Uint8Array<ArrayBuffer>>;
    function writeFile(path: string | URL, data: Uint8Array): Promise<void>;
    function readTextFile(path: string | URL): Promise<string>;

    namespace errors {
        class NotFound extends Error {}
        class PermissionDenied extends Error {}
    }
}
