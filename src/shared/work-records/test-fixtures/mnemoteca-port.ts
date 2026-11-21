import type { WorkRecordMnemotecaPort } from "../mnemoteca-port.ts";

export interface IndexedFixtureDocument {
    id: number;
    tags: string[];
    content: string;
}

export interface WorkRecordMnemotecaFixture extends WorkRecordMnemotecaPort {
    snapshot(): IndexedFixtureDocument[];
    commands(): string[][];
}

export function createWorkRecordMnemotecaFixture(): WorkRecordMnemotecaFixture {
    let documents: IndexedFixtureDocument[] = [];
    const commands: string[][] = [];
    let nextId = 1;
    const encode = (text: string) => new TextEncoder().encode(text);
    const result = (stdout = "", code = 0) => ({
        success: code === 0,
        code,
        stdout: encode(stdout),
        stderr: new Uint8Array(),
    });
    const optionValues = (args: string[], name: string): string[] => {
        const values: string[] = [];
        for (let index = 0; index < args.length - 1; index += 1) {
            if (args[index] === name) values.push(args[index + 1]);
        }
        return values;
    };
    return {
        snapshot() {
            return structuredClone(documents);
        },
        commands() {
            return structuredClone(commands);
        },
        run(args) {
            commands.push([...args]);
            const command = args[0] || "";
            if (command === "update" && args[1] === "--help") {
                return Promise.resolve(result("Usage: mnemoteca update <id> --replace-tags"));
            }
            if (command === "forget") {
                documents = [];
                return Promise.resolve(result());
            }
            if (command === "init") return Promise.resolve(result());
            if (command === "add") {
                documents.push({ id: nextId++, tags: optionValues(args, "--tag"), content: args.at(-1) || "" });
                return Promise.resolve(result());
            }
            if (command === "update") {
                const id = Number(args[1]);
                const document = documents.find((candidate) => candidate.id === id);
                if (!document) return Promise.resolve(result("", 1));
                document.tags = optionValues(args, "--tag");
                document.content = args.at(-1) || "";
                return Promise.resolve(result());
            }
            if (command === "delete") {
                documents = documents.filter((document) => document.id !== Number(args[1]));
                return Promise.resolve(result());
            }
            if (command === "list") {
                const locator = optionValues(args, "--tag")[0];
                const matches = locator ? documents.filter((document) => document.tags.includes(locator)) : documents;
                return Promise.resolve(result(matches.map((document) => `[${document.id}] fixture`).join("\n")));
            }
            if (command === "search") {
                const query = (args.at(-1) || "").toLowerCase();
                const matches = documents.filter((document) => document.content.toLowerCase().includes(query));
                return Promise.resolve(
                    result(
                        JSON.stringify({
                            results: matches.map((document) => ({ metadata: { tags: document.tags } })),
                        }),
                    ),
                );
            }
            return Promise.resolve(result(`Unsupported fixture command: ${command}`, 1));
        },
    };
}
