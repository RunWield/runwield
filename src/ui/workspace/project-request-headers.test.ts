import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { assertEquals } from "../../testing/assertions.ts";

const pages = [{ path: "./pages/projects/[projectId]/settings.astro", helper: "rwSettingsOwnerFetch" }];

async function requestThroughPage(path: string, helper: string, options: RequestInit = {}) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const script = source.match(/<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error(`Missing inline script in ${path}`);
    let sentHeaders = new Headers();
    await runInNewContext(`${script}\n${helper}('/api/owner/projects', options);`, {
        document: { cookie: "rw_owner_csrf=csrf%3Dproof", querySelectorAll: () => [] },
        Headers,
        options,
        fetch: (url: string, init: RequestInit) => {
            assertEquals(url, "/api/owner/projects");
            assertEquals(init.method, options.method);
            assertEquals(init.body, options.body);
            assertEquals(init.credentials, options.credentials);
            sentHeaders = new Headers(init.headers);
            return Promise.resolve(new Response("{}", { status: 200 }));
        },
    });
    return sentHeaders;
}

type HeaderForm = { name: string; make: () => HeadersInit };
const headerForms: HeaderForm[] = [
    { name: "Headers", make: () => new Headers({ "x-request-proof": "retained" }) },
    { name: "tuples", make: () => [["x-request-proof", "retained"]] },
    { name: "record", make: () => ({ "x-request-proof": "retained" }) },
];

for (const page of pages) {
    for (const form of headerForms) {
        test(`${page.helper} preserves ${form.name} headers and owner defaults`, async () => {
            const headers = form.make();
            const options: RequestInit = { method: "POST", body: "{}", credentials: "same-origin", headers };
            const sent = await requestThroughPage(page.path, page.helper, options);
            assertEquals(sent.get("x-request-proof"), "retained");
            assertEquals(sent.get("content-type"), "application/json");
            assertEquals(sent.get("x-runwield-csrf"), "csrf=proof");
            assertEquals(options.headers, headers);
            assertEquals([...new Headers(headers)], [["x-request-proof", "retained"]]);
        });
    }

    test(`${page.helper} supplies defaults without custom headers`, async () => {
        const sent = await requestThroughPage(page.path, page.helper);
        assertEquals(sent.get("content-type"), "application/json");
        assertEquals(sent.get("x-runwield-csrf"), "csrf=proof");
    });

    const overrideForms: HeaderForm[] = [
        {
            name: "Headers",
            make: () => new Headers({ "Content-Type": "text/plain", "X-RunWield-CSRF": "explicit-proof" }),
        },
        {
            name: "tuples",
            make: () => [
                ["Content-Type", "text/plain"],
                ["X-RunWield-CSRF", "explicit-proof"],
            ],
        },
        { name: "record", make: () => ({ "Content-Type": "text/plain", "X-RunWield-CSRF": "explicit-proof" }) },
    ];
    for (const form of overrideForms) {
        test(`${page.helper} preserves case-insensitive ${form.name} overrides without mutating input`, async () => {
            const headers = form.make();
            const before = structuredClone(headers instanceof Headers ? [...headers] : headers);
            const options = Object.freeze({ method: "POST", headers });
            const sent = await requestThroughPage(page.path, page.helper, options);
            assertEquals(sent.get("content-type"), "text/plain");
            assertEquals(sent.get("x-runwield-csrf"), "explicit-proof");
            assertEquals(options.headers, headers);
            assertEquals(headers instanceof Headers ? [...headers] : headers, before);
        });
    }
}
