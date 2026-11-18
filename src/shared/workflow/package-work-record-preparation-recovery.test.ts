import { test } from "node:test";
import { assertRecordingResumes } from "./testing/package-recording-resume-scenario.ts";

for (const boundary of ["source", "sections", "pending", "backlink", "manifest"]) {
    test(`fresh validation resumes after durable ${boundary} without a second accepted Recorder output`, async () => {
        await assertRecordingResumes(boundary);
    });
}
