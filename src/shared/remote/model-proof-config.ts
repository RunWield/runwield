import { isAbsolute } from "node:path";

export interface RemoteModelProof {
    provider: string;
    modelId: string;
    sentinelFile: string;
}

/** Reject malformed opt-ins before any SSH or personal-resource setup. */
export function parseRemoteModelProof(text: string): RemoteModelProof {
    let value: RemoteModelProof;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Invalid WLD_REMOTE_MODEL_PROOF");
    }
    if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "modelId,provider,sentinelFile" ||
        typeof value.provider !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.provider) ||
        typeof value.modelId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value.modelId) ||
        typeof value.sentinelFile !== "string" || value.sentinelFile.length > 256 ||
        isAbsolute(value.sentinelFile) ||
        !value.sentinelFile.split("/").every((part) =>
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== ".." && part !== ".wld"
        )
    ) throw new Error("Invalid WLD_REMOTE_MODEL_PROOF");
    return value;
}
