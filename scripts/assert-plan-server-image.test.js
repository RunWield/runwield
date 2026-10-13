import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import {
    assertPlanServerImageFileList,
    isProhibitedImageFile,
    REQUIRED_IMAGE_DIRECTORIES,
    REQUIRED_IMAGE_FILES,
} from "./assert-plan-server-image.js";

test("assertPlanServerImageFileList accepts minimal generated runtime image files and required directories", () => {
    const result = assertPlanServerImageFileList([
        ...REQUIRED_IMAGE_FILES,
        "/app/dist/workspace-runtime/client/styles.css",
        "/app/src/agent-definitions/engineer.md",
    ], [...REQUIRED_IMAGE_DIRECTORIES]);

    assertEquals(result, { missingRequired: [], missingRequiredDirectories: [], prohibited: [] });
});

test("assertPlanServerImageFileList rejects repository source state and secret artifacts", () => {
    const result = assertPlanServerImageFileList([
        ...REQUIRED_IMAGE_FILES.filter((file) => file !== "/app/brand/logo.svg"),
        "/app/src/ui/workspace/server.js",
        "/app/src/ui/workspace/workspace.test.js",
        "/app/docs/plans/example.md",
        "/app/.wld/collaboration-secrets.json",
        "/app/.git/config",
        "/app/sessions/session.jsonl",
        "/app/data/runwield.sqlite",
        "/app/deno.json",
    ], []);

    assertEquals(result.missingRequired, ["/app/brand/logo.svg"]);
    assertEquals(result.missingRequiredDirectories, ["/data"]);
    assertEquals(result.prohibited, [
        "/app/.git/config",
        "/app/.wld/collaboration-secrets.json",
        "/app/data/runwield.sqlite",
        "/app/deno.json",
        "/app/docs/plans/example.md",
        "/app/sessions/session.jsonl",
        "/app/src/ui/workspace/server.js",
        "/app/src/ui/workspace/workspace.test.js",
    ]);
});

test("isProhibitedImageFile allows only passive assets below /app/src", () => {
    assertEquals(isProhibitedImageFile("/app/src/agent-definitions/router.md"), false);
    assertEquals(isProhibitedImageFile("/app/src/agent-definitions/subagent-definitions/reviewer-prompt.md"), true);
    assertEquals(isProhibitedImageFile("/app/src/ui/design-system/tokens.css"), false);
    assertEquals(isProhibitedImageFile("/app/src/ui/theme/catppuccin-mocha.json"), false);
    assertEquals(isProhibitedImageFile("/app/src/shared/collaboration/secrets.js"), true);
    assertEquals(isProhibitedImageFile("/app/src/ui/theme/unlisted-theme.json"), true);
});
