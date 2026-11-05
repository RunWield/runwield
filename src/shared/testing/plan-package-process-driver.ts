/** Subprocess fault injection at actual filesystem boundaries; package machinery remains real. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { DriverRequest } from "./plan-package-fixture.ts";
import { openNativeFileLock } from "../native-file-lock.ts";

const request: DriverRequest = JSON.parse(process.argv[2]);
const project = join(request.identity.executionAccountHome, ".wld", "projects", request.identity.projectId);
const internal = join(project, "internal", "plan-packages");
const originalRename = fs.renameSync;
const originalMove = promises.rename;
const exit = (boundary: string) => {
    if (request.boundary === boundary) process.exit(86);
};
const observedRename = (from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    const path = String(to);
    if (path.includes("/staging/") && path.endsWith("plan.wld.json")) exit("staged-package");
    if (path.endsWith("/intent.json")) exit("intent");
    if (path.includes("/plans/") && path.endsWith("plan.wld.json")) exit("metadata");
    if (path.endsWith("/input.wld.json")) {
        if (request.edit) {
            const target = join(project, "plans", request.name ?? "one", request.edit);
            if (request.remove) fs.unlinkSync(target);
            else fs.writeFileSync(target, "edited while capturing\n");
        }
        exit("staged-input");
    }
};
// Bun named builtin imports retain their original binding; replace only the external syscall export.
mock.module("node:fs", () => ({ ...fs, renameSync: observedRename, default: fs }));
Object.defineProperty(promises, "rename", {
    value: async (...args: Parameters<typeof promises.rename>) => {
        await originalMove(...args);
        if (String(args[1]).includes("/plans/") && String(args[1]).endsWith("context.md")) exit("moved-resource");
        if (String(args[1]).includes("/inputs/")) exit("published-input");
    },
});
const originalReadDirectory = promises.readdir;
let interruptedScan = false;
Object.defineProperty(promises, "readdir", {
    value: async (...args: Parameters<typeof promises.readdir>) => {
        if (
            request.boundary === "start-rename-during-scan" &&
            !interruptedScan &&
            String(args[0]) === join(project, "plans")
        ) {
            interruptedScan = true;
            const result = spawnSync(
                process.execPath,
                [process.argv[1], JSON.stringify({ ...request, command: "rename", boundary: "metadata" })],
                { encoding: "utf8" },
            );
            if (result.status !== 86)
                throw new Error(`Rename did not reach publication: ${result.stdout} ${result.stderr}`);
        }
        return await originalReadDirectory(...args);
    },
});
const store = await import("../../plan-store.js");
const planId = request.planId ?? "plan-one";
try {
    if (request.command === "hold") {
        const key = createHash("sha256").update(planId).digest("hex");
        const lock = openNativeFileLock(join(internal, "locks", `${key}.lock`));
        await lock.lock(true);
        console.log("ready");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    } else {
        const current = request.command === "create" ? null : await store.readPlanPackage(request.identity, { planId });
        console.log("ready");
        if (request.barrier)
            while (!fs.existsSync(request.barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
        let result;
        switch (request.command) {
            case "create":
                result = await store.createPlanPackage(request.identity, {
                    planId,
                    name: request.name ?? "one",
                    documents: { "context.md": "# Created\n", "validation.md": "# Validate\n" },
                });
                break;
            case "read":
                result = current;
                break;
            case "input":
                result = await store.readPlanPackageInput(request.identity, {
                    projectId: request.identity.projectId,
                    planId,
                    inputId: request.inputId!,
                });
                break;
            case "capture":
                result = await store.capturePlanPackageInput(request.identity, planId);
                break;
            default:
                if (!current || current.kind !== "loaded") throw new Error(JSON.stringify(current));
                if (request.command === "metadata")
                    result = await store.updatePlanPackageMetadata(
                        request.identity,
                        planId,
                        current.metadata.revision,
                        { controller: { validationCiAttempts: 3 } },
                    );
                if (request.command === "document")
                    result = await store.savePlanPackageDocument(
                        request.identity,
                        planId,
                        "context.md",
                        current.documents[0].hash,
                        "# Concurrent edit\n",
                    );
                if (request.command === "rename")
                    result = await store.renamePlanPackage(
                        request.identity,
                        planId,
                        current.metadata.revision,
                        request.name ?? "renamed",
                    );
        }
        console.log(JSON.stringify({ kind: "success", result }));
    }
} catch (error) {
    console.log(JSON.stringify({ kind: error instanceof Error ? error.name : "error", message: String(error) }));
    process.exitCode = 2;
}
