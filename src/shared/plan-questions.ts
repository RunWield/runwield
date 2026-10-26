import type { InterviewQuestion } from "../tools/user-interview.ts";

export interface PlanQuestionAnswer {
    id: string;
    value: boolean | string;
}

export interface PlanQuestionBlock {
    id?: string;
    question?: InterviewQuestion;
    start: number;
    end: number;
    error?: string;
}

/** Read top-level fences without mistaking examples inside longer fences for questions. */
export function parsePlanQuestions(markdown: string): PlanQuestionBlock[] {
    const blocks: PlanQuestionBlock[] = [];
    const lines = [...markdown.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter((line) => line[0]);
    for (let index = 0; index < lines.length; index++) {
        const opening = lines[index][0].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
        if (!opening) continue;
        const fence = opening[1];
        let closing = index + 1;
        const closePattern = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|\\r)?$`);
        while (closing < lines.length && !closePattern.test(lines[closing][0])) closing++;
        if (opening[2].trim() === "wld-question") {
            const start = lines[index].index!;
            const end =
                closing < lines.length
                    ? lines[closing].index! + lines[closing][0].replace(/[\r\n]+$/, "").length
                    : markdown.length;
            const block: PlanQuestionBlock = { start, end };
            try {
                if (closing === lines.length) throw new Error("Question fence is not closed.");
                const question: InterviewQuestion = JSON.parse(
                    lines
                        .slice(index + 1, closing)
                        .map((line) => line[0])
                        .join(""),
                );
                if (!question || typeof question !== "object" || Array.isArray(question)) {
                    throw new Error("Question must be a JSON object.");
                }
                if (typeof question.id !== "string" || !question.id.trim()) throw new Error("Question needs an id.");
                block.id = question.id;
                if (!["yes_no", "text", "multiple_choice"].includes(question.type)) {
                    throw new Error("Question type must be yes_no, text, or multiple_choice.");
                }
                if (typeof question.prompt !== "string" || !question.prompt.trim()) {
                    throw new Error("Question needs a prompt.");
                }
                if (
                    question.type === "multiple_choice" &&
                    (!Array.isArray(question.choices) ||
                        !question.choices.length ||
                        question.choices.some(
                            (choice) =>
                                !choice ||
                                typeof choice.value !== "string" ||
                                !choice.value.trim() ||
                                (choice.label !== undefined && typeof choice.label !== "string"),
                        ))
                ) {
                    throw new Error("Multiple-choice questions need choices with string values.");
                }
                if (
                    question.default !== undefined &&
                    typeof question.default !== (question.type === "yes_no" ? "boolean" : "string")
                ) {
                    throw new Error("Recommended answer does not match the question type.");
                }
                block.question = question;
            } catch (error) {
                block.error = error instanceof Error ? error.message : "Invalid question JSON.";
            }
            blocks.push(block);
        }
        index = closing;
    }
    const counts = new Map<string, number>();
    for (const block of blocks) if (block.id) counts.set(block.id, (counts.get(block.id) || 0) + 1);
    for (const block of blocks) {
        if (block.id && counts.get(block.id)! > 1) {
            block.error = `Duplicate question id: ${block.id}.`;
            delete block.question;
        }
    }
    return blocks;
}

function answerLabel(question: InterviewQuestion, value: boolean | string): string {
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return question.type === "multiple_choice"
        ? question.choices.find((choice) => choice.value === value)?.label || value
        : value;
}

/** Replace only valid fences; retain all surrounding source bytes. */
export function resolvePlanQuestions(markdown: string, answers: PlanQuestionAnswer[] = []): string {
    let resolved = markdown;
    for (const block of parsePlanQuestions(markdown).reverse()) {
        if (!block.question || block.error) continue;
        const answer = answers.find((entry) => entry.id === block.id);
        const value = answer?.value ?? block.question.default;
        const label =
            value === undefined
                ? "Not answered. Engineer decides."
                : `${answerLabel(block.question, value)} (${answer ? "answered in review" : "recommended; not answered in review"})`;
        const quote = (text: string) => text.replace(/\r\n|\n|\r/g, "\n> ");
        const replacement = `> **Question (${block.id}):** ${quote(block.question.prompt)}\n>\n> **Answer:** ${quote(label)}`;
        resolved = resolved.slice(0, block.start) + replacement + resolved.slice(block.end);
    }
    return resolved;
}

export function formatPlanQuestionAnswers(questions: PlanQuestionBlock[], answers: PlanQuestionAnswer[]): string {
    const lines = questions.flatMap((block) => {
        const answer = answers.find((entry) => entry.id === block.id);
        if (!block.question || block.error || !answer) return [];
        const text = answerLabel(block.question, answer.value).replace(/\r\n|\n|\r/g, " ");
        return [`- ${block.id}: ${block.question.prompt.replace(/\r\n|\n|\r/g, " ")} — ${text}`];
    });
    return lines.length ? `### Question answers\n\n${lines.join("\n")}` : "";
}
