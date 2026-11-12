import { captureForegroundProcess } from "../../../shared/captured-process.ts";
import { inspectLocalHomeStore } from "../../../plan-store/access.ts";
import { withLocalPlanWorkflow } from "../../../plan-store/index.ts";
import { selectedPackage } from "../../../plan-store/workflows.ts";
import { packagePublicationInput } from "../../../plan-store/index.ts";
import { readPublishedDeliverySources } from "../../../plan-store/index.ts";
import { parsePlanFrontMatter } from "../../../plan-format.ts";

async function remoteGit(root: string, remote: string, args: string[]) {
    const result = await captureForegroundProcess("git", { cwd: root, args: ["--git-dir", remote, ...args] });
    if (result.code !== 0) throw new Error("Golden publication evidence is not available in the remote target.");
    return new TextDecoder().decode(result.stdout);
}

/** Prove publication from the real owner receipt, retained input and remote Git ancestry. */
export async function readGoldenPublishedPlan(root: string, name: string, remote: string, head: string) {
    if (inspectLocalHomeStore(root).kind !== "local") {
        const markdown = await remoteGit(root, remote, ["show", `${head}:docs/plans/${name}.md`]);
        return { ...parsePlanFrontMatter(markdown), markdown };
    }
    return await withLocalPlanWorkflow(root, name, async () => {
        const plan = await selectedPackage(name);
        const receipt = plan.metadata.workflow?.delivery;
        if (!receipt || receipt.mode === "non_git_in_place")
            throw new Error("Expected a confirmed Git delivery receipt.");
        await remoteGit(root, remote, ["merge-base", "--is-ancestor", receipt.publishedCommit, head]);
        await remoteGit(root, remote, ["merge-base", "--is-ancestor", receipt.validatedCommit, head]);
        const manifest = await packagePublicationInput(root, receipt.source);
        for (const copy of manifest.copies) {
            const bytes = await remoteGit(root, remote, ["show", `${receipt.publishedCommit}:${copy.path}`]);
            if (bytes !== copy.text) throw new Error(`Published copy differs from the sealed input: ${copy.path}`);
        }
        const sources = await readPublishedDeliverySources(root, {
            phase: "publication_verified",
            packageInput: receipt.source,
            artifactCommit: receipt.publishedCommit,
            planName: name,
            planId: plan.metadata.planId,
        });
        return {
            markdown:
                manifest.copies.find((copy) => copy.kind === "plan" && copy.path === `docs/plans/${name}/context.md`)
                    ?.text ?? sources.delivered.body,
            body: sources.delivered.body,
            attrs: { ...sources.delivered.attrs, validatedCommit: receipt.validatedCommit },
        };
    });
}
