import { test } from "node:test";
import { publicationBoundaries, resumePublicationBoundary } from "./testing/package-publication-boundaries.ts";

for (const boundary of publicationBoundaries) {
    test(`fresh process resumes ${boundary}, copies true`, () => resumePublicationBoundary(true, boundary));
}
