import process from "node:process";
import { writeFile as fsWriteFile } from "node:fs/promises";
// Executable fixture for the real subprocess boundary. It never contacts a provider.
import { getCwd } from "../../../../../constants.js";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
async function main() {
    const mode = process.env["RUNWIELD_IMAGE_FIXTURE_MODE"] || "success";
    const argsPath = process.env["RUNWIELD_IMAGE_FIXTURE_ARGS"];
    if (argsPath) await fsWriteFile(argsPath, JSON.stringify(process.argv.slice(2)));
    if (mode === "wait") await new Promise((resolve) => setTimeout(resolve, 60_000));
    const path = `${getCwd()}/generated.png`;
    await fsWriteFile(path, Uint8Array.from(atob(png), (char) => char.charCodeAt(0)));
    const response = JSON.stringify({
        path: mode === "outside" ? process.env["RUNWIELD_IMAGE_FIXTURE_OUTSIDE"] : path,
    });
    console.log(
        JSON.stringify({ event: "init", conversation_id: "image-fixture", init: { tools: ["generate_image"] } }),
    );
    console.log(JSON.stringify({
        event: "step_update",
        step_update: {
            state: mode === "false-success" ? "ERROR" : "DONE",
            step_index: 2,
            step_type: "tool",
            tool_name: "generate_image",
            tool_info: { name: "generate_image", output: mode === "false-success" ? "no image generated" : "done" },
        },
    }));
    console.log(
        JSON.stringify({
            event: "result",
            result: {
                status: "SUCCESS",
                response,
                structured_output: JSON.parse(response),
                conversation_id: "image-fixture",
            },
        }),
    );
}

if (import.meta.main) await main();
