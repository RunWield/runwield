import { test } from "node:test";
import { publicationBoundaries, resumePublicationBoundary } from "./testing/package-publication-boundaries.ts";

for (const boundary of publicationBoundaries) {
    if (boundary === "artifact_effect") continue; // No copies means no commit effect to interrupt.
    test(`fresh process resumes ${boundary}, copies false`, () => resumePublicationBoundary(false, boundary));
}
