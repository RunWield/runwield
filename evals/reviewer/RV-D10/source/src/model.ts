export interface PublicationRequest {
    remote: string;
    targetRef: string;
    candidate: string;
}

export interface PublicationAttempt extends PublicationRequest {
    preparedCommit: string;
    expectedTarget: string;
    status: "pending" | "published";
    error: string | null;
}
