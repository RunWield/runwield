import { enterProjectRuntime } from "../../project-runtime-layout.ts";
await enterProjectRuntime(process.argv[2]);
console.log("complete");
