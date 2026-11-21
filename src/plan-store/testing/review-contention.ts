import { mock } from "bun:test";
import { existsSync } from "node:fs";
import { openNativeFileLock } from "../../shared/native-file-lock.ts";
import type { ProjectIdentity } from "../../shared/project-identity.ts";
interface ReviewContender {
    identity: ProjectIdentity;
    barrier: string;
}

const request: ReviewContender = JSON.parse(process.argv[2]);
const open = openNativeFileLock;
let enteringReview = false;
mock.module("../../shared/native-file-lock.ts", () => ({
    openNativeFileLock: (path: string, create?: boolean | "exclusive") => {
        const lock = open(path, create);
        return {
            ...lock,
            async lock(exclusive = false) {
                if (lock.tryLockSync(exclusive)) return;
                if (enteringReview) console.log("waiting for lock");
                await lock.lock(exclusive);
            },
        };
    },
}));
const { withPackageWorkflow } = await import("../workflows.ts");
const { runPlanReviewDecisionTransition } = await import("../transitions.ts");
const result = await withPackageWorkflow(
    request.identity.checkoutRoot,
    { identity: request.identity, planId: "plan-one", expectedRevision: 1 },
    async () => {
        console.log("ready");
        while (!existsSync(request.barrier!)) await new Promise((resolve) => setTimeout(resolve, 5));
        enteringReview = true;
        return await runPlanReviewDecisionTransition({
            projectRoot: request.identity.checkoutRoot,
            planName: "one",
            approved: true,
            decide: () => Promise.resolve("second"),
        });
    },
);
console.log(JSON.stringify({ result }));
