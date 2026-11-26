const DEFAULT_SEE_IMAGE_PROMPT =
    "Describe this image in detail for a text-only coding agent. Include all visible UI/content, readable text and error messages, relevant layout, controls, highlighted regions, and visual state. If text or details are unclear, say so explicitly.";

/** Resolve the text to submit to the configured vision model. */
export function resolveImageQuestion(question?: string): string {
    return question?.trim() || DEFAULT_SEE_IMAGE_PROMPT;
}
