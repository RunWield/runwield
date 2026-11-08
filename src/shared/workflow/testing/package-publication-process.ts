/** Kill actual durable filesystem effects, then use the ordinary publication driver. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { mock } from "bun:test";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rename = fs.renameSync;
mock.module("node:fs", () => ({
    ...fs,
    default: fs,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
        rename(from, to);
        const path = String(to);
        if (
            config.crashAfter === "retained_input" &&
            path.includes("/plan-packages/publications/") &&
            path.endsWith(".json")
        )
            process.exit(86);
        if (path.endsWith("/plan.wld.json")) {
            const metadata = JSON.parse(fs.readFileSync(path, "utf8"));
            if (
                config.crashAfter === "parent_completion" &&
                metadata.planId === "parent" &&
                metadata.definition.status === "reviewed" &&
                metadata.definition.epicCompletionMode === "done_enough"
            )
                process.exit(86);
            if (config.crashAfter === "input_reference" && metadata.workflow?.publication) process.exit(86);
            if (
                config.crashAfter === "revalidation_reset" &&
                metadata.definition.status === "implemented" &&
                metadata.workflow?.publication
            )
                process.exit(86);
            if (config.crashAfter === "package_settlement" && metadata.workflow?.delivery) process.exit(86);
        }
    },
}));
const move = promises.rename;
const write = promises.writeFile;
async function writeCopy(...args: Parameters<typeof promises.writeFile>) {
    await write(...args);
    if (config.crashAfter === "copy_write" && String(args[0]) === `${config.executionCwd}/docs/plans/one/context.md`)
        process.exit(86);
}
mock.module("node:fs/promises", () => ({
    ...promises,
    default: { ...promises, writeFile: writeCopy },
    writeFile: writeCopy,
    async rename(from: Parameters<typeof promises.rename>[0], to: Parameters<typeof promises.rename>[1]) {
        await move(from, to);
        if (String(to).endsWith("/worktrees.json")) {
            const registry = JSON.parse(fs.readFileSync(to, "utf8"));
            const attempt = registry.entries?.find(
                (entry: { id: string }) => entry.id === config.attemptId,
            )?.publication;
            if (config.crashAfter === "revalidation_intent" && attempt?.revalidation) process.exit(86);
            if (config.crashAfter === "candidate_receipt" && attempt?.phase === "candidate_sealed") process.exit(86);
            if (config.crashAfter === "artifact_receipt" && attempt?.phase === "artifacts_committed") process.exit(86);
        }
    },
}));
await import("./publication-process-driver.ts");
