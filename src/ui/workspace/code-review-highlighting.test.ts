import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: Astro workspace check uses browser tsconfig without Deno/JSR test globals.
import { test } from "node:test";
import {
    getCustomExtensionsMap,
    getCustomExtensionsVersion,
    getFiletypeFromFileName,
    hasResolvedLanguages,
    replaceCustomExtensions,
    setCustomExtension,
} from "@pierre/diffs";

import { codeReviewLanguagesFor, prepareCodeReviewHighlighting } from "./react/code-review-highlighting.ts";

test("code review detects JSX and TSX grammars through Pierre", () => {
    assertEquals(
        codeReviewLanguagesFor([
            "src/ui/components/ReviewBadge.tsx",
            "src/ui/components/ReviewAction.jsx",
            "notes/readme.unknown-extension",
        ]),
        ["tsx", "jsx"],
    );
});

test("code review preparation resolves grammars into Pierre's cache", async () => {
    const paths = [
        "src/ui/components/ReviewBadge.tsx",
        "src/ui/components/ReviewAction.jsx",
    ];

    const result = await prepareCodeReviewHighlighting(paths);

    assertEquals(result.fallbacks, []);
    assertEquals(hasResolvedLanguages(codeReviewLanguagesFor(paths)), true);
});

test("code review preparation falls back unresolvable grammars to text", async () => {
    const originalVersion = getCustomExtensionsVersion();
    const originalExtensions = getCustomExtensionsMap();
    try {
        setCustomExtension("rw-broken", "runwield-test-missing-language");
        const path = "src/ui/components/fallback.rw-broken";

        const result = await prepareCodeReviewHighlighting([path]);

        assertEquals(getFiletypeFromFileName(path), "text");
        assertEquals(result.fallbacks, [{
            path,
            lookupKey: "rw-broken",
            language: "runwield-test-missing-language",
        }]);
    } finally {
        replaceCustomExtensions(originalVersion + 1000, originalExtensions);
    }
});
