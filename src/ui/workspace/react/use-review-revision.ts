import { useEffect, useState } from "react";

interface ReviewRevisionPayload {
    reviewRevisionUrl?: string;
    reviewRevision?: number;
    token: string;
}

/** Bind decisions to the displayed revision and reload after a repair. */
export function useReviewRevision(
    payload: ReviewRevisionPayload,
    waiting: boolean,
    onError: (message: string) => void,
) {
    const [revision, setRevision] = useState(payload.reviewRevision);
    useEffect(() => {
        const revisionUrl = payload.reviewRevisionUrl;
        if (!waiting || !revisionUrl) return;
        const controller = new AbortController();
        const waitForRevision = async () => {
            try {
                while (!controller.signal.aborted) {
                    const url = new URL(revisionUrl, globalThis.location.href);
                    url.searchParams.set("token", payload.token);
                    const response = await fetch(url, { signal: controller.signal });
                    if (!response.ok) throw new Error("The review host stopped. Reopen the review in Claude.");
                    const current: { revision: number } = await response.json();
                    if (current.revision > (revision ?? 0)) {
                        globalThis.location.reload();
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 750));
                }
            } catch (caught) {
                if (!controller.signal.aborted) onError(caught instanceof Error ? caught.message : String(caught));
            }
        };
        void waitForRevision();
        return () => controller.abort();
    }, [waiting, payload, onError, revision]);
    return {
        fields: payload.reviewRevisionUrl ? { reviewRevision: revision } : {},
        update: setRevision,
    };
}
