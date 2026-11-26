/** Keep old settings and transcripts readable without offering the removed provider. */
export function isRemovedAgyProvider(provider: string | undefined): boolean {
    return provider === "agy-cli";
}

/** A saved model selection refers to the retired Antigravity CLI. */
export class RemovedAgyModelError extends Error {
    constructor(modelRef: string, action: string) {
        super(`Antigravity (agy-cli) was removed. ${modelRef}: ${action}`);
        this.name = "RemovedAgyModelError";
    }
}

/** Describe how the host can recover from a saved Antigravity model selection. */
export function removedAgyModelError(modelRef: string, action: string): RemovedAgyModelError {
    return new RemovedAgyModelError(modelRef, action);
}
