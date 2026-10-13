import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { StandaloneCodeReviewActions } from "./StandaloneCodeReviewActions.tsx";
import type { StandaloneReviewPayload } from "../../review/review-launcher.ts";
function render(review?: StandaloneReviewPayload, destination = "forge") {
    return renderToStaticMarkup(
        <StandaloneCodeReviewActions
            review={review}
            destination={destination}
            busy={false}
            hasAnnotations
            resultMessage=""
            onDestination={() => {}}
            onAction={() => {}}
            onEngineer={() => {}}
        />,
    );
}
test("PR destination offers only neutral comments and approval", () => {
    const html = render({
        mode: "pr",
        forge: { platform: "github", label: "GitHub", available: true, postEnabled: true },
    });
    assertStringIncludes(html, "Post comments");
    assertStringIncludes(html, ">Approve<");
    assertEquals(html.includes("Send to Engineer"), false);
    assertEquals(html.includes("Request changes"), false);
});
test("PR Engineer destination offers feedback, not approval", () => {
    const html = render({ mode: "pr" }, "engineer");
    assertStringIncludes(html, "Send to Engineer");
    assertEquals(html.includes(">Approve<"), false);
});
test("branch review has only Engineer feedback", () => {
    const html = render({ mode: "branch" });
    assertStringIncludes(html, "Send to Engineer");
    assertEquals(html.includes("Approve"), false);
    assertEquals(html.includes("Open PR"), false);
});
test("uncommitted review exposes the Operator commit rule", () => {
    const html = render({ mode: "uncommitted", commit: { enabled: true } });
    assertStringIncludes(html, "Send to Engineer");
    assertStringIncludes(html, "Approve &amp; Commit");
    assertStringIncludes(html, "The Operator writes a commit message, commits, and pushes these changes.");
});
test("unavailable Forge retains disabled actions and a visible reason", () => {
    const html = render({
        mode: "pr",
        forge: {
            platform: "github",
            label: "GitHub",
            available: false,
            postEnabled: false,
            unavailableReason: "Run gh auth login.",
        },
    });
    assertStringIncludes(html, "Run gh auth login.");
    assertEquals((html.match(/disabled=""/g) || []).length, 2);
});
test("validation payload gets no standalone actions", () => {
    assertEquals(render(), "");
});
