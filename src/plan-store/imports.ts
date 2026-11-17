import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectLocalHomeStore } from "./access.ts";
import { importPlanPackages, withPlanPackageLocks } from "./packages.ts";
import { enterProjectRuntime } from "../shared/project-runtime-layout.ts";
import { resolvePrimaryCheckoutRoot } from "../shared/primary-checkout.ts";
import { writeJsonAtomically } from "../shared/private-json-file.ts";
import { getExactProjectCustomSetting, setExactProjectCustomSetting } from "../shared/settings.js";

/** Explicit admission and source-preserving import are one store operation. */
export async function importPlans(cwd: string, selection: string) {
    await enterProjectRuntime(cwd);
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") throw new Error("Plan import requires the local execution-account store.");
    const result = await importPlanPackages(store.identity, resolve(cwd, selection));
    if ("message" in result) throw new Error(result.message);
    return result;
}

interface ImportCopyChoice {
    version: number;
    deliveryCopies: boolean;
}

/** Returns whether this repository-folder import still needs the user's one-time copy choice. */
export async function importedPlanCopyChoice(cwd: string, selection: string, answer?: boolean): Promise<boolean> {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const plansRoot = await realpath(join(projectRoot, "docs/plans")).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    const selectedPath = resolve(cwd, selection);
    if (!plansRoot || !(await stat(selectedPath)).isDirectory()) return false;
    const selected = await realpath(selectedPath);
    const path = relative(plansRoot, selected);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return false;
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind !== "local") return false;
    return await withPlanPackageLocks(owner.identity, [], async () => {
        const choicePath = join(
            owner.identity.executionAccountHome,
            ".wld/projects",
            owner.identity.projectId,
            "internal/plan-packages/import-copy-choice.json",
        );
        const choiceBytes = await readFile(choicePath, "utf8").catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (choiceBytes !== null) {
            const choice: ImportCopyChoice = JSON.parse(choiceBytes);
            if (choice.version !== 1 || typeof choice.deliveryCopies !== "boolean")
                throw new Error("Invalid saved Plan import choice.");
            return false;
        }
        const stored = getExactProjectCustomSetting("plans", projectRoot);
        const settings = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
        if ("importDeliveryCopiesAnswer" in settings && typeof settings.importDeliveryCopiesAnswer === "boolean") {
            writeJsonAtomically(choicePath, { version: 1, deliveryCopies: settings.importDeliveryCopiesAnswer });
            return false;
        }
        if (answer === undefined) return true;
        setExactProjectCustomSetting(
            "plans",
            { ...settings, deliveryCopies: answer, importDeliveryCopiesAnswer: answer },
            projectRoot,
        );
        writeJsonAtomically(choicePath, { version: 1, deliveryCopies: answer });
        return false;
    });
}
