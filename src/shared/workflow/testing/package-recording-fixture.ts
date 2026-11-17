import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "./package-publication-fixture.ts";
import { setExactProjectCustomSetting } from "../../settings.js";
import { captureForegroundProcess } from "../../captured-process.ts";
import type { ValidationHostResume, HostTurnValidationResult } from "../validation-host-contract.ts";

export async function recordingFixture(
    policy?: { plans: boolean; workRecords: boolean },
    family?: "child" | "epic" | "last-child",
    local = false,
    supersedes?: string[],
) {
    const f = await publicationFixture(false, [], family, local, undefined, supersedes);
    delete f.config.packageSelection.deliveryCopies;
    setExactProjectCustomSetting("codereview", "none", f.root);
    if (policy) {
        setExactProjectCustomSetting("plans", { deliveryCopies: policy.plans }, f.root);
        setExactProjectCustomSetting("workRecords", { deliveryCopies: policy.workRecords }, f.root);
    }
    const countPath = join(f.root, ".wld/recorder-count");
    return {
        ...f,
        countPath,
        async validate(
            options: {
                boundary?: string;
                requestOnly?: boolean;
                failRecorder?: boolean;
                resume?: ValidationHostResume;
            } = {},
        ) {
            const configPath = join(f.root, ".wld/recording-driver.json");
            await fs.mkdir(join(f.root, ".wld"), { recursive: true });
            await fs.writeFile(
                configPath,
                JSON.stringify({ selection: f.config.packageSelection, countPath, ...options }),
            );
            const result = await captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [new URL("./package-recording-process.ts", import.meta.url).pathname, configPath],
            });
            const text = new TextDecoder().decode(result.stdout);
            const errors = new TextDecoder().decode(result.stderr);
            const line = text.trim().split("\n").at(-1);
            const outcome: HostTurnValidationResult | undefined =
                result.code === 0 && line?.startsWith("{") ? JSON.parse(line) : undefined;
            return { code: result.code, text: text + errors, outcome };
        },
        async recorderIds() {
            return (await fs.readFile(countPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
        },
        async turns() {
            return (await fs.readFile(countPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
        },
    };
}
