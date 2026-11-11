import process from "node:process";
import { realpath, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getCwd } from "../../constants.js";
import { writeJsonAtomically } from "../../shared/private-json-file.ts";
import { importPlanPackages, withPlanPackageLocks } from "../../shared/plan-package-store.ts";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { inspectLocalHomeStore } from "../../shared/local-home-store.ts";
import { resolvePrimaryCheckoutRoot } from "../../shared/primary-checkout.ts";
import { getExactProjectCustomSetting, setExactProjectCustomSetting } from "../../shared/settings.js";
import { admitProjectWithIdentityChoice } from "../../ui/tui/project-identity-entry.ts";

async function offerDeliveryCopies(cwd: string, selection: string): Promise<void> {
    const projectRoot = resolvePrimaryCheckoutRoot(cwd);
    const plansRoot = await realpath(join(projectRoot, "docs/plans")).catch(() => null);
    if (!plansRoot || !(await stat(selection)).isDirectory()) return;
    const selected = await realpath(selection);
    const path = relative(plansRoot, selected);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return;
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind !== "local") return;
    await withPlanPackageLocks(owner.identity, [], async () => {
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
            const choice: { version: number; deliveryCopies: boolean } = JSON.parse(choiceBytes);
            if (choice.version !== 1 || typeof choice.deliveryCopies !== "boolean")
                throw new Error("Invalid saved Plan import choice.");
            return;
        }
        const stored = getExactProjectCustomSetting("plans", projectRoot);
        const settings = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
        if ("importDeliveryCopiesAnswer" in settings && typeof settings.importDeliveryCopiesAnswer === "boolean") {
            writeJsonAtomically(choicePath, { version: 1, deliveryCopies: settings.importDeliveryCopiesAnswer });
            return;
        }
        if (!process.stdin.isTTY) {
            console.log(
                "[RunWield] Plans imported. Delivery copies remain unchanged; choose them on a later interactive folder import.",
            );
            return;
        }
        const answer = prompt("Keep delivered Plan copies in docs/plans/? [Y/n]");
        if (answer === null) return;
        const normalized = answer.trim().toLowerCase();
        if (!["", "y", "yes", "n", "no"].includes(normalized)) return;
        const accepted = normalized === "" || normalized === "y" || normalized === "yes";
        setExactProjectCustomSetting(
            "plans",
            {
                ...settings,
                deliveryCopies: accepted,
                importDeliveryCopiesAnswer: accepted,
            },
            projectRoot,
        );
        writeJsonAtomically(choicePath, { version: 1, deliveryCopies: accepted });
    });
}

export async function runPlansImportCommand(argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(
            "Usage: wld plans import <file-or-folder>\nImport Plans into personal home storage without changing source files.",
        );
        return;
    }
    if (argv.length !== 1 || argv[0].startsWith("-")) throw new Error("Usage: wld plans import <file-or-folder>");
    const cwd = getCwd();
    if (!(await admitProjectWithIdentityChoice(cwd))) return;
    await enterProjectRuntime(cwd);
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") throw new Error("Plan import requires the local execution-account store.");
    const selection = resolve(cwd, argv[0]);
    const result = await importPlanPackages(store.identity, selection);
    if ("message" in result) throw new Error(result.message);
    console.log(
        `[RunWield] Imported ${result.importedPlanIds.length} Plans; ${result.existingPlanIds.length} already present.`,
    );
    await offerDeliveryCopies(cwd, selection);
}
