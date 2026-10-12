/** Native executable fixture for external helpers during Windows qualification. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { argv, execPath } from "node:process";

const name = basename(execPath).replace(/\.exe$/i, "");
const args = argv.slice(2);
const directory = dirname(execPath);
appendFileSync(`${directory}/calls.log`, [name, ...args].join("\n") + "\n");
let accepted = false;
if (args[0] === "--help" && (name === "mnemoteca" || (args.length === 1 && ["cymbal", "ketch"].includes(name)))) {
    console.log(`Usage: ${name} <command>`);
    accepted = true;
} else if (name === "mnemoteca") {
    if (args[0] === "update" && args[1] === "--help") {
        console.log("Usage: mnemoteca update <id> --replace-tags");
        accepted = true;
    } else if (args[0] === "list") {
        console.log("No documents");
        accepted = true;
    } else if (args[0] === "search") {
        console.log('{"results":[]}');
        accepted = true;
    } else if (["init", "add", "forget"].includes(args[0])) accepted = true;
    else if (args[0] === "export") {
        const index = args.indexOf("--output");
        if (index >= 0 && args[index + 1]) {
            mkdirSync(dirname(args[index + 1]), { recursive: true });
            writeFileSync(args[index + 1], '{"type":"mnemoteca-export"}\n');
            accepted = true;
        }
    }
} else if (name === "cymbal") {
    if (args.join(" ") === "index .") accepted = true;
    else if (args.join(" ") === "--no-federate show FixtureSymbol") {
        console.log("Fixture symbol");
        accepted = true;
    } else if (args.join(" ") === "--no-federate outline readme.txt") {
        console.log("Fixture outline");
        accepted = true;
    } else if (args.slice(0, 5).join(" ") === "--no-federate hook nudge --format=text --") accepted = true;
}
if (name === "gh") {
    console.error("golden fixture: gh unavailable");
    process.exitCode = 1;
    accepted = true;
}
if (name === "osascript" && args.length === 2 && args[0] === "-e" && args[1] === `try
        the clipboard as «class PNGf»
        return "image"
      on error
        return "none"
      end try`) {
    console.log("none");
    accepted = true;
}
if (!accepted) {
    const message = `Unsupported ${name} fixture call: ${args.join(" ")}\n`;
    appendFileSync(`${directory}/unexpected.log`, message);
    console.error(message);
    process.exitCode = 64;
}
