import { Command } from "./command.ts";

export function startValidation(executable: string, args: string[]): Command {
    return new Command(executable, args);
}
