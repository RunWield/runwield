/** A fresh, network-denied host invocation used by the integration journey. */
import { continueHostTurnValidation, type ContinueHostTurnValidationArgs } from "../validation-host-turn.ts";
const args: ContinueHostTurnValidationArgs = JSON.parse(Deno.args[0]);
console.log("HOST_RESULT=" + JSON.stringify(await continueHostTurnValidation(args)));
