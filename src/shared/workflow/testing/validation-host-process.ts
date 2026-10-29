import type { ContinueHostTurnValidationArgs } from "../validation-host-turn.ts";
import { denyNetwork } from "../../../testing/deny-network.ts";
denyNetwork();
const { continueHostTurnValidation } = await import("../validation-host-turn.ts");
import process from "node:process";
/** A fresh, network-denied host invocation used by the integration journey. */

const args: ContinueHostTurnValidationArgs = JSON.parse(process.argv.slice(2)[0]);
console.log("HOST_RESULT=" + JSON.stringify(await continueHostTurnValidation(args)));
