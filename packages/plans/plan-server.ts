/** Portable Plan Server transport, encryption, review links and wire validation. */
export { decodeBase64Url, decodeUtf8Base64Url, encodeBase64Url, encodeUtf8Base64Url } from "./plan-server/base64url.ts";
export {
    generateBearerCapability,
    hashCapability,
    MAINTAINER_SCOPE,
    redactCapabilityValue,
    redactSecrets,
    REVIEWER_SCOPE,
    timingSafeEqual,
    type CapabilityScope,
} from "./plan-server/capabilities.ts";
export {
    CollaborationApiError,
    CollaborationClient,
    PlanServerUpgradeRequiredError,
    SharedSpaceGoneError,
    createCollaborationClient,
    SYSTEM_COLLABORATION_FETCH,
    type CollaborationClientOptions,
} from "./plan-server/client.ts";
export {
    openPlanServerConnection,
    type PlanServerConnection,
    type PreparedSharedSpace,
} from "./plan-server/connection.ts";
export {
    decryptJsonPayload,
    encryptJsonPayload,
    exportContentKey,
    generateContentKey,
    generateContentKeyString,
    importContentKey,
} from "./plan-server/crypto.ts";
export {
    assertNonEmptyString,
    assertPositiveInteger,
    assertRecord,
    normalizeApiErrorPayload,
    normalizeAppendCommentPayload,
    normalizeAppendRevisionPayload,
    normalizeCapabilityRecord,
    normalizeCommentStateChangePayload,
    normalizeCreateSharedSpacePayload,
    normalizeDecryptedReviewCommentPayload,
    normalizeEncryptedCommentRecord,
    normalizeEncryptedPlanPayload,
    normalizeLocalSecretRecord,
    normalizeRevisionMetadata,
    normalizeSharedSpaceLifecyclePayload,
    normalizeSharedSpaceMetadata,
    SHARED_SPACE_IDEMPOTENCY_HEADER,
    SHARED_SPACE_GONE_CODE,
    type AppendCommentPayload,
    type AppendRevisionPayload,
    type CapabilityRecord,
    type CommentStateChangePayload,
    type CreateSharedSpacePayload,
    type DecryptedReviewCommentPayload,
    type EncryptedCommentRecord,
    type EncryptedPlanPayload,
    type LocalSecretRecord,
    type RevisionMetadata,
    type SharedSpaceMetadata,
} from "./plan-server/protocol.ts";
export {
    buildApiUrl,
    buildCollaborationUrl,
    parseCollaborationUrl,
    redactCollaborationUrl,
} from "./plan-server/urls.ts";
