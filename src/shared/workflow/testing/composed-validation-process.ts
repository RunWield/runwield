import { continueHostTurnValidation, type ValidationHostResume } from "../validation-host-turn.ts";

const [projectRoot, planName, savedResume, hold] = process.argv.slice(2);
const resume: ValidationHostResume | undefined = savedResume ? JSON.parse(savedResume) : undefined;
const result = await continueHostTurnValidation({ projectRoot, planName, resume });
console.log(JSON.stringify(result));
// A host can disconnect while Core is durably waiting for its Recorder response.
if (hold === "hold") await new Promise<void>(() => setInterval(() => {}, 1000));
