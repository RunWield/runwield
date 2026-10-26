import { isApprovalAcceptedValue } from "../shared/session/interaction-values.ts";
import {
    RuntimeInteractionOutcomes,
    type RuntimeInteractionRequest,
    type RuntimeInteractionResponse,
    RuntimeInteractionTypes,
} from "../shared/session/session-runtime-interactions.js";

function displayLabel(label: string) {
    return label.replace(/\s*\(recommended\)$/i, "");
}

function menuOptions(interaction: RuntimeInteractionRequest) {
    if (interaction.type === RuntimeInteractionTypes.APPROVAL && !interaction.options?.length) {
        return [
            { value: "accept", label: "Yes" },
            { value: "decline", label: "No" },
        ];
    }
    return interaction.options || [];
}

export function formatChatQuestion(interaction: RuntimeInteractionRequest) {
    if (interaction._meta?.source !== "user_interview") {
        return [
            interaction.prompt,
            ...menuOptions(interaction).map(
                (option, index) =>
                    `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
            ),
            interaction.type === RuntimeInteractionTypes.TEXT
                ? "Write your answer."
                : 'Reply with a number or the exact option name or value, or "cancel".',
        ].join("\n\n");
    }
    const options = (interaction.options || []).map((option, index) => {
        const recommended = /\s*\(recommended\)$/i.test(option.label);
        return `${index + 1}. ${displayLabel(option.label)}${recommended ? " — recommended" : ""}`;
    });
    return [
        interaction.prompt,
        ...options,
        interaction.type === RuntimeInteractionTypes.SELECT
            ? "Reply with a number or write your answer."
            : "Write your answer.",
    ].join("\n\n");
}

export function parseChatReply(
    interaction: RuntimeInteractionRequest,
    text: string,
): RuntimeInteractionResponse | null {
    const trimmed = text.trim();
    if (interaction._meta?.source !== "user_interview") {
        if (!trimmed) return null;
        if (interaction.type === RuntimeInteractionTypes.TEXT) {
            return { outcome: RuntimeInteractionOutcomes.TEXT, value: trimmed };
        }
        const options = menuOptions(interaction);
        const number = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
        const matches = options.filter((option) =>
            [option.label, option.value].some((value) => value.trim().toLowerCase() === trimmed.toLowerCase()),
        );
        const option =
            number >= 1 && number <= options.length ? options[number - 1] : matches.length === 1 ? matches[0] : null;
        if (!option)
            return matches.length === 0 && trimmed.toLowerCase() === "cancel"
                ? { outcome: RuntimeInteractionOutcomes.CANCELED }
                : null;
        if (interaction.type === RuntimeInteractionTypes.APPROVAL) {
            const accepted = isApprovalAcceptedValue(interaction, option.value);
            return {
                outcome: accepted ? RuntimeInteractionOutcomes.ACCEPTED : RuntimeInteractionOutcomes.CANCELED,
                value: accepted,
            };
        }
        return { outcome: RuntimeInteractionOutcomes.SELECTED, value: option.value, valueLabel: option.label };
    }
    if (!trimmed && !interaction.allowEmpty) return null;
    if (interaction.type === RuntimeInteractionTypes.TEXT) {
        return { outcome: RuntimeInteractionOutcomes.TEXT, value: interaction.allowEmpty ? text : trimmed };
    }
    const options = interaction.options || [];
    const number = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
    const matches = options.filter((option) => displayLabel(option.label).toLowerCase() === trimmed.toLowerCase());
    const option =
        number >= 1 && number <= options.length ? options[number - 1] : matches.length === 1 ? matches[0] : null;
    if (option) {
        return {
            outcome: RuntimeInteractionOutcomes.SELECTED,
            value: option.value,
            valueLabel: option.label,
        };
    }
    return {
        outcome: RuntimeInteractionOutcomes.SELECTED,
        value: interaction.otherOptionValue || "other",
        valueLabel: "Other",
        otherText: trimmed,
    };
}
