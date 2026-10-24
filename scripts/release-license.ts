import { parseReleaseTag } from "./release.js";

/** License metadata for release recovery as well as new publication. */
export function releaseLicense(version: string) {
    const { major, minor, patch, rc } = parseReleaseTag(`v${version}`);
    // The v0.14 release line (including its candidates) introduces MIT. Recovering an
    // earlier Free Use release with current packaging must not silently relicense it.
    // v0.1.0 predates Free Use and already shipped MIT.
    const originalMitRelease = major === 0 && minor === 1 && patch === 0 && rc === undefined;
    const mit = originalMitRelease || major > 0 || minor >= 14;
    return {
        homebrew: mit ? '"MIT"' : ":cannot_represent",
        winget: mit ? "MIT" : "Free Use License",
    };
}
