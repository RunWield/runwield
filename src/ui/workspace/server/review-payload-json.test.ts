import { test } from "node:test";
import { assertEquals, assertFalse } from "../../../testing/assertions.ts";
import { escapeReviewPayloadJson } from "./review-payload-json.ts";

test("embedded review JSON cannot close its script element", () => {
    const payload = {
        rawPatch: "const closingTag = '</script>';\n<div>source text, not page content</div>&",
    };
    const encoded = escapeReviewPayloadJson(JSON.stringify(payload));

    assertFalse(encoded.includes("</script>"));
    assertFalse(encoded.includes("<div>"));
    assertEquals(JSON.parse(encoded), payload);
});
