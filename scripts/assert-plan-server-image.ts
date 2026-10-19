import { captureScriptProcess } from "./script-process.ts";
import process from "node:process";
/**
 * Inspect a built Plan Server OCI image and assert the final filesystem does not
 * include repository source, Plans, local state, tests, VCS metadata, or SQLite
 * artifacts.
 */

const DEFAULT_IMAGE = "runwield-plan-server:local";

export const REQUIRED_IMAGE_FILES = Object.freeze([
    "/app/remote-server.js",
    "/app/dist/workspace-runtime/server.mjs",
    "/app/brand/logo.svg",
    "/app/src/agent-definitions/router.md",
    "/app/src/ui/workspace/static/styles.css",
    "/app/src/ui/workspace/static/workspace.css",
    "/app/src/ui/design-system/tokens.css",
    "/app/src/ui/design-system/components.css",
    "/app/src/ui/theme/catppuccin-mocha.json",
]);

export const REQUIRED_IMAGE_DIRECTORIES = Object.freeze(["/data"]);

const ALLOWED_APP_SRC_FILES = new Set([
    "/app/src/agent-definitions/architect.md",
    "/app/src/agent-definitions/engineer.md",
    "/app/src/agent-definitions/guide.md",
    "/app/src/agent-definitions/ideator.md",
    "/app/src/agent-definitions/operator.md",
    "/app/src/agent-definitions/planner.md",
    "/app/src/agent-definitions/recorder.md",
    "/app/src/agent-definitions/router.md",
    "/app/src/agent-definitions/tester.md",
    "/app/src/ui/workspace/static/styles.css",
    "/app/src/ui/workspace/static/workspace.css",
    "/app/src/ui/design-system/tokens.css",
    "/app/src/ui/design-system/components.css",
    "/app/src/ui/theme/catppuccin-mocha.json",
]);

export interface ImageFilesystemAssertion {
    missingRequired: string[];
    missingRequiredDirectories: string[];
    prohibited: string[];
}

export function assertPlanServerImageFileList(files: string[], directories: string[]): ImageFilesystemAssertion {
    const fileSet = new Set(files);
    const directorySet = new Set(directories);
    const missingRequired = REQUIRED_IMAGE_FILES.filter((file) => !fileSet.has(file));
    const missingRequiredDirectories = REQUIRED_IMAGE_DIRECTORIES.filter((directory) => !directorySet.has(directory));
    const prohibited = files.filter(isProhibitedImageFile).sort();
    return { missingRequired, missingRequiredDirectories, prohibited };
}

export function isProhibitedImageFile(file: string): boolean {
    if (!file.startsWith("/app/")) return false;
    if (file === "/app/remote-server.js") return false;
    if (file.startsWith("/app/dist/workspace-runtime/")) return false;
    if (ALLOWED_APP_SRC_FILES.has(file)) return false;

    return (
        file.startsWith("/app/docs/plans/") ||
        file.startsWith("/app/.wld/") ||
        file.startsWith("/app/.git/") ||
        file.startsWith("/app/sessions/") ||
        file.includes("/sessions/") ||
        file.includes("collaboration-secrets.json") ||
        file.endsWith(".sqlite") ||
        file.includes(".sqlite-") ||
        file.endsWith(".db") ||
        file.includes(".db-") ||
        file.includes(".test.") ||
        file.startsWith("/app/src/") ||
        file === "/app/deno.json" ||
        file === "/app/deno.lock"
    );
}

export interface ImageFilesystemListing {
    files: string[];
    directories: string[];
}

const IMAGE_DIRECTORY_DELIMITER = "__RUNWIELD_IMAGE_DIRECTORIES__";

export async function listImageFilesystem(image: string, engine = "podman"): Promise<ImageFilesystemListing> {
    if (!["podman", "docker"].includes(engine)) throw new Error(`Unsupported container engine: ${engine}`);
    const result = await captureScriptProcess(engine, {
        args: [
            "run",
            "--rm",
            "--entrypoint",
            "/bin/sh",
            image,
            "-c",
            `find /app -type f | sort; printf '%s\\n' ${IMAGE_DIRECTORY_DELIMITER}; if [ -d /data ]; then find /data -maxdepth 0 -type d | sort; fi`,
        ],
        stdout: "piped",
        stderr: "piped",
    });
    const decoder = new TextDecoder();
    if (!result.success) {
        throw new Error(decoder.decode(result.stderr).trim() || `${engine} run failed with exit code ${result.code}`);
    }
    const lines = decoder.decode(result.stdout).trim().split("\n").filter(Boolean);
    const delimiterIndex = lines.indexOf(IMAGE_DIRECTORY_DELIMITER);
    if (delimiterIndex === -1) {
        throw new Error(`${engine} image filesystem listing did not include the directory delimiter`);
    }
    return {
        files: lines.slice(0, delimiterIndex),
        directories: lines.slice(delimiterIndex + 1),
    };
}

export async function listImageFiles(image: string): Promise<string[]> {
    return (await listImageFilesystem(image)).files;
}

if (import.meta.main) {
    const image = process.argv.slice(2)[0] || DEFAULT_IMAGE;
    const listing = await listImageFilesystem(image);
    const result = assertPlanServerImageFileList(listing.files, listing.directories);
    if (
        result.missingRequired.length > 0 ||
        result.missingRequiredDirectories.length > 0 ||
        result.prohibited.length > 0
    ) {
        console.error(JSON.stringify(result, null, 2));
        process.exit(1);
    }
    console.log(
        `Plan Server image ${image} contains required runtime files/directories and no prohibited repository artifacts.`,
    );
}
