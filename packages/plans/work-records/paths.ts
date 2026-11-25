import { assertContainedPath, ContainedPathError } from "@runwield/resources/fs";

export async function assertWorkRecordContainedPath(root: string, path: string): Promise<void> {
    try {
        await assertContainedPath(root, path);
    } catch (error) {
        if (!(error instanceof ContainedPathError)) throw error;
        if (error.reason === "symbolic_link") throw new Error("Work Record path contains a symbolic link.");
        throw new Error("Work Record path leaves its owner.");
    }
}
