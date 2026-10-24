import { listArtifacts, readArtifact } from "./archive.ts";

export async function runCommand(root: string, args: string[]): Promise<string> {
    if (args[0] === "list") return JSON.stringify(await listArtifacts(root));
    if (args[0] === "read" && args[1]) return readArtifact(root, args[1]);
    throw new Error("Use list or read <path>");
}
