import type { JsonValue } from "@runwield/parsing/jsonc";
import type { PlanFrontMatter } from "../document.ts";
import { normalizePlanServerUrl } from "../format/collaboration.ts";
import { generateBearerCapability, hashCapability, MAINTAINER_SCOPE, REVIEWER_SCOPE } from "./capabilities.ts";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "./client.ts";
import { encryptJsonPayload, exportContentKey, generateContentKey } from "./crypto.ts";
import { normalizeEncryptedPlanPayload, normalizeSharedSpaceMetadata } from "./protocol.ts";

import type {
    CreateSharedSpacePayload,
    EncryptedPlanPayload,
    ProtocolRecord,
    SharedSpaceMetadata,
} from "./protocol.ts";

/** Encrypted create request and the credentials kept by the personal owner. */
export interface PreparedSharedSpace {
    createPayload: CreateSharedSpacePayload;
    contentKey: string;
    reviewerCapability: string;
    maintainerCapability: string;
}

/** The selected Plan Server and credential mode used for sharing. */
export interface PlanServerConnection {
    prepareSharedSpace(payload: EncryptedPlanPayload<ProtocolRecord | PlanFrontMatter>): Promise<PreparedSharedSpace>;
    replaySharedSpace(payload: CreateSharedSpacePayload, requestId: string): Promise<SharedSpaceMetadata>;
}

/** Resolve the connection for this normalized Plan Server URL. */
export function openPlanServerConnection(serverUrl: string): PlanServerConnection {
    // Account sign-in will resolve credentials for this normalized URL here.
    const client = createCollaborationClient({
        serverUrl: normalizePlanServerUrl(serverUrl),
        fetch: SYSTEM_COLLABORATION_FETCH,
    });
    return {
        async prepareSharedSpace(payload) {
            const plan = normalizeEncryptedPlanPayload(payload);
            const key = await generateContentKey();
            const reviewerCapability = generateBearerCapability();
            const maintainerCapability = generateBearerCapability();
            const [contentKey, payloadCiphertext, reviewerHash, maintainerHash] = await Promise.all([
                exportContentKey(key),
                encryptJsonPayload(plan, key),
                hashCapability(reviewerCapability),
                hashCapability(maintainerCapability),
            ]);
            return {
                createPayload: {
                    planId: plan.planId,
                    initialRevision: { payloadCiphertext },
                    capabilities: [
                        { scope: REVIEWER_SCOPE, capabilityHash: reviewerHash },
                        { scope: MAINTAINER_SCOPE, capabilityHash: maintainerHash },
                    ],
                },
                contentKey,
                reviewerCapability,
                maintainerCapability,
            };
        },
        async replaySharedSpace(payload, requestId) {
            return normalizeCreateResponse(await client.replaySharedSpace(payload, requestId), payload.planId);
        },
    };
}

function normalizeCreateResponse(value: JsonValue | undefined, planId: string): SharedSpaceMetadata {
    if (value && typeof value === "object" && !Array.isArray(value) && "space" in value) {
        return normalizeCreateResponse(value.space, planId);
    }
    const metadata = normalizeSharedSpaceMetadata(value);
    if (metadata.planId !== planId) throw new Error("Plan Server create response must match the shared Plan ID.");
    if (metadata.latestRevision !== 1) throw new Error("Plan Server create response must report latestRevision 1.");
    return metadata;
}
