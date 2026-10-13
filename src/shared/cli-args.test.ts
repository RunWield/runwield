import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { parseArgs } from "./cli-args.ts";

test("CLI flags preserve aliases, last values and literal negative names", () => {
    const parsed = parseArgs(["-h", "--out", "first", "-o", "second", "--no-open", "--count", "3"], {
        boolean: ["help", "no-open"],
        string: ["out"],
        alias: { h: "help", o: "out" },
    });
    deepStrictEqual(parsed, { _: [], help: true, h: true, out: "second", o: "second", "no-open": true, count: 3 });
    deepStrictEqual(parseArgs(["--help=false"], { boolean: ["help"] }), { _: [], help: false });
});

test("CLI command tails and explicit terminators preserve literal arguments", () => {
    deepStrictEqual(
        parseArgs(["-h", "command", "--mode", "001"], { boolean: ["help"], alias: { h: "help" }, stopEarly: true }),
        { _: ["command", "--mode", "001"], h: true, help: true },
    );
    deepStrictEqual(parseArgs(["--", "--help", "001"], { boolean: ["help"] }), { _: ["--help", "001"], help: false });
    deepStrictEqual(parseArgs(["--out", "001"], { string: ["out"] }), { _: [], out: "001" });
});

test("CLI property-like flags do not modify object prototypes", () => {
    parseArgs(["--__proto__.polluted", "yes", "--constructor.prototype.polluted", "yes"]);
    strictEqual(Reflect.get({}, "polluted"), undefined);
});
