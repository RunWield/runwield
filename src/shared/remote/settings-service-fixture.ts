import process from "node:process";
import { readStreamInto } from "../socket-listener.ts";
import { startRemoteControlService } from "./control.ts";
import { setCustomSetting } from "../settings.js";

if (process.argv[2] === "write") {
    await setCustomSetting("theme", "light", "global");
    process.exit(0);
}

const service = startRemoteControlService({ buildId: "b".repeat(64), protocol: 1 });
console.log(JSON.stringify({ port: service.port, credential: service.credential }));
const buffer = new Uint8Array(1);
await readStreamInto(process.stdin, buffer);
await service.close();
