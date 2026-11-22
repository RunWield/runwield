import { Type } from "typebox";

export const INIT_VERIFICATION_COMMAND_TOOL_NAME = "init_save_verification_command";

const PARAMETERS = Type.Object(
    {
        command: Type.Optional(
            Type.String({
                description: "User-confirmed shell command for project verification.",
            }),
        ),
        setupCommand: Type.Optional(
            Type.String({
                description:
                    "User-confirmed fresh-worktree setup command. An empty string explicitly means no setup is required.",
            }),
        ),
        verificationNotImplemented: Type.Optional(
            Type.Boolean({
                description: "Set true when the user confirms that project verification is not implemented.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const initVerificationCommandDefinition = {
    name: INIT_VERIFICATION_COMMAND_TOOL_NAME,
    label: "Save Init Project Commands",
    description:
        "Save user-confirmed verification and/or worktree setup commands to .wld/settings.json during Init. Omitted commands remain unchanged.",
    promptSnippet:
        "init_save_verification_command(command | verificationNotImplemented, setupCommand): Save either confirmed project command or both; empty setupCommand means no setup required.",
    parameters: PARAMETERS,
} as const;
