import type { Static } from "typebox";
import type { initVerificationCommandDefinition } from "./definitions/init-verification-command.ts";

export const INIT_VERIFICATION_COMMAND_PLACEHOLDER = 'echo "verification not implemented yet"';

type InitVerificationCommandParameters = Static<typeof initVerificationCommandDefinition.parameters>;

export type PreparedProjectCommands =
    { ok: true; verificationCommand?: string; setupCommand?: string } | { ok: false; reason: string };

/** Trim the supplied commands and preserve omissions so the caller can write only the requested settings. */
export function prepareProjectCommands(params: InitVerificationCommandParameters): PreparedProjectCommands {
    const hasVerification = params.command !== undefined || params.verificationNotImplemented !== undefined;
    const command = params.command?.trim() || "";
    const usePlaceholder = params.verificationNotImplemented === true;
    const setupCommand = params.setupCommand?.trim();
    if ((hasVerification && usePlaceholder === Boolean(command)) || (!hasVerification && setupCommand === undefined)) {
        return {
            ok: false,
            reason: "Provide a non-empty verification command or verificationNotImplemented true, a setupCommand (empty means no setup), or both resolved commands.",
        };
    }
    return {
        ok: true,
        ...(hasVerification
            ? { verificationCommand: usePlaceholder ? INIT_VERIFICATION_COMMAND_PLACEHOLDER : command }
            : {}),
        ...(setupCommand !== undefined ? { setupCommand } : {}),
    };
}
