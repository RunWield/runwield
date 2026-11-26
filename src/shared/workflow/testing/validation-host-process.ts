import { denyNetwork } from "../../../testing/deny-network.ts";
denyNetwork();
const { runHostValidation } = await import("./run-host-validation.ts");
import process from "node:process";
/** A fresh, network-denied host invocation used by the integration journey. */

const args: Parameters<typeof runHostValidation>[0] = JSON.parse(process.argv.slice(2)[0]);
console.log("HOST_RESULT=" + JSON.stringify(await runHostValidation(args)));
