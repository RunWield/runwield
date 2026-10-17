import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Block } from "@plannotator/ui/types.ts";
import type { PlanQuestionAnswer, PlanQuestionBlock } from "../../../shared/plan-questions.ts";

interface PlanQuestionBlocksProps {
    containerRef: RefObject<HTMLElement | null>;
    markdown: string;
    blocks: Block[];
    questions: PlanQuestionBlock[];
    answers: PlanQuestionAnswer[];
    onAnswer: (id: string, value: boolean | string) => void;
}
interface QuestionMount {
    question: PlanQuestionBlock;
    target: HTMLElement;
}

/** Mount beside the upstream code block, and restore its source on unmount. */
export function PlanQuestionBlocks({
    containerRef,
    markdown,
    blocks,
    questions,
    answers,
    onAnswer,
}: PlanQuestionBlocksProps) {
    const [mounts, setMounts] = useState<QuestionMount[]>([]);
    useEffect(() => {
        const codeBlocks = blocks.filter((block) => block.type === "code" && block.language === "wld-question");
        const cleanups: (() => void)[] = [];
        const next: QuestionMount[] = [];
        questions.forEach((question) => {
            const startLine = markdown.slice(0, question.start).split("\n").length;
            const block = codeBlocks.find((candidate) => candidate.startLine === startLine);
            if (!block) return;
            const element = Array.from(
                containerRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") || [],
            ).find((candidate) => candidate.dataset.blockId === block.id);
            const pre = element?.querySelector("pre");
            if (!element || !pre) return;
            const target = document.createElement("div");
            element.append(target);
            if (!question.error) {
                pre.hidden = true;
                element.classList.add("rw-plan-question-mounted");
            }
            next.push({ question, target });
            cleanups.push(() => {
                pre.hidden = false;
                element.classList.remove("rw-plan-question-mounted");
                target.remove();
            });
        });
        setMounts(next);
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [blocks, questions, containerRef, markdown]);
    return mounts.map(({ question: block, target }, index) =>
        createPortal(
            block.error ? (
                <p className="rw-question-error" role="note">
                    Plan Question: {block.error}
                </p>
            ) : (
                <QuestionForm
                    block={block}
                    value={answers.find((answer) => answer.id === block.id)?.value}
                    onAnswer={onAnswer}
                />
            ),
            target,
            String(index),
        ),
    );
}

interface QuestionFormProps {
    block: PlanQuestionBlock;
    value?: boolean | string;
    onAnswer: PlanQuestionBlocksProps["onAnswer"];
}

function QuestionForm({ block, value, onAnswer }: QuestionFormProps) {
    const question = block.question!;
    const id = block.id!;
    const choices =
        question.type === "yes_no"
            ? [
                  { value: true, label: "Yes" },
                  { value: false, label: "No" },
              ]
            : question.type === "multiple_choice"
              ? question.choices
              : [];
    const [otherSelected, setOtherSelected] = useState(false);
    const isOther =
        question.type === "multiple_choice" &&
        (otherSelected || (typeof value === "string" && !question.choices.some((choice) => choice.value === value)));
    return (
        <div className="rw-question-card" onPointerDown={(event) => event.stopPropagation()}>
            <fieldset className="rw-question-field">
                <legend>{question.prompt}</legend>
                {question.type === "text" ? (
                    <>
                        {question.default !== undefined && (
                            <p className="rw-question-help">Recommended: {question.default}</p>
                        )}
                        <textarea
                            aria-label={question.prompt}
                            placeholder={question.placeholder}
                            value={typeof value === "string" ? value : ""}
                            onChange={(event) => onAnswer(id, event.target.value)}
                        />
                    </>
                ) : (
                    <>
                        {choices.map((choice) => (
                            <label className="rw-question-option" key={String(choice.value)}>
                                <input
                                    type="radio"
                                    name={`plan-question-${id}`}
                                    checked={!isOther && value === choice.value}
                                    onChange={() => {
                                        setOtherSelected(false);
                                        onAnswer(id, choice.value);
                                    }}
                                />
                                <span>
                                    {choice.label || String(choice.value)}
                                    {question.default === choice.value && (
                                        <span className="rw-question-help"> — Recommended</span>
                                    )}
                                </span>
                            </label>
                        ))}
                        {question.type === "multiple_choice" && (
                            <>
                                <label className="rw-question-option">
                                    <input
                                        type="radio"
                                        name={`plan-question-${id}`}
                                        checked={isOther}
                                        onChange={() => {
                                            setOtherSelected(true);
                                            onAnswer(id, "");
                                        }}
                                    />
                                    <span>Other</span>
                                </label>
                                {isOther && (
                                    <textarea
                                        className="rw-plan-question-other"
                                        placeholder="Enter your answer"
                                        aria-label={`Other answer: ${question.prompt}`}
                                        value={typeof value === "string" && isOther ? value : ""}
                                        onChange={(event) => onAnswer(id, event.target.value)}
                                    />
                                )}
                            </>
                        )}
                    </>
                )}
            </fieldset>
        </div>
    );
}
