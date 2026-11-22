import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects } from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopDraftStore } from "./draft-store.ts";

const locator = { projectId: "registration-a", durableSessionId: "saved-a", composerKey: "composer-a" };
const composer = {
    text: "  exact text\n\t  ",
    requestId: "saved-request",
    images: [{ id: "image-a", name: "private.png", mimeType: "image/png", base64: "YWJj" }],
};
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "desktop-drafts-"));
    return {
        root,
        store: await DesktopDraftStore.open(root),
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
}

test("private drafts retain exact text, images, queue and submitted request identities after reopening", async () => {
    const f = await fixture();
    try {
        await f.store.write(locator, composer);
        await f.store.submit(locator, {
            ...composer,
            expectedGeneration: 3,
            kind: "prompt",
            images: composer.images.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
        });
        const second = { ...locator, composerKey: "second", durableSessionId: "saved-b" };
        await f.store.queue(second, { requestId: "queued-id", text: "explicit send only", images: [] });
        if (process.platform !== "win32") {
            equal((await stat(f.store.directory)).mode & 0o777, 0o700);
            equal((await stat(f.store.path)).mode & 0o777, 0o600);
        }
        const restored = await DesktopDraftStore.open(f.root);
        deepEqual((await restored.read(locator))?.composer, composer);
        equal((await restored.read(locator))?.submitted[0].requestId, composer.requestId);
        equal((await restored.read(second))?.queued[0].requestId, "queued-id");
        if (process.platform !== "win32") {
            equal((await stat(restored.directory)).mode & 0o777, 0o700);
            equal((await stat(restored.path)).mode & 0o777, 0o600);
        }
    } finally {
        await f.cleanup();
    }
});

test("acceptance and discard delete only named intent and reject delayed writes without losing another binding", async () => {
    const f = await fixture();
    try {
        const other = { ...locator, durableSessionId: "other", composerKey: "other" };
        await f.store.write(locator, composer);
        await f.store.write(other, composer);
        await f.store.submit(locator, {
            requestId: composer.requestId,
            text: composer.text,
            images: [],
            expectedGeneration: 3,
            kind: "prompt",
        });
        await f.store.accepted(locator, composer.requestId);
        await f.store.write(locator, composer);
        equal(await f.store.read(locator), null);
        deepEqual((await f.store.read(other))?.composer, composer);
        await f.store.discard(other);
        await f.store.write(other, composer);
        equal(await f.store.read(other), null);
        deepEqual(await (await DesktopDraftStore.open(f.root)).list(), []);
    } finally {
        await f.cleanup();
    }
});

test("composer identity reconciles to saved identity and project removal keeps other projects", async () => {
    const f = await fixture();
    try {
        const fresh = { ...locator, durableSessionId: "" };
        await f.store.write(fresh, composer);
        const rebound = { ...fresh, composerKey: "replacement-wire" };
        await f.store.restoreBinding(fresh, rebound);
        equal(await f.store.read(fresh), null);
        deepEqual((await f.store.read(rebound))?.composer, composer);
        await f.store.bind({ ...locator, composerKey: rebound.composerKey });
        equal(await f.store.read(rebound), null);
        deepEqual((await f.store.read(locator))?.composer, composer);
        const other = { ...locator, projectId: "registration-b" };
        await f.store.write(other, composer);
        await f.store.removeProject(locator.projectId);
        equal(await f.store.read(locator), null);
        await rejects(() => f.store.write(locator, composer), /registration was removed/);
        deepEqual((await f.store.read(other))?.composer, composer);
    } finally {
        await f.cleanup();
    }
});

test("queue editing transfers its request identity without treating it as accepted", async () => {
    const f = await fixture();
    try {
        await f.store.queue(locator, { requestId: "edit-id", text: "edit this", images: [] });
        const edited = await f.store.editQueued(locator, "edit-id");
        equal(edited.requestId, "edit-id");
        edited.text = "changed exact intent";
        await f.store.write(locator, edited);
        const reopened = await DesktopDraftStore.open(f.root);
        equal((await reopened.read(locator))?.composer?.text, edited.text);
        deepEqual((await reopened.read(locator))?.queued, []);
    } finally {
        await f.cleanup();
    }
});

test("invalid image input cannot replace saved private intent", async () => {
    const f = await fixture();
    try {
        await f.store.write(locator, composer);
        await rejects(async () =>
            f.store.write(locator, { ...composer, images: [{ ...composer.images[0], base64: "not base64" }] }),
        );
        deepEqual((await (await DesktopDraftStore.open(f.root)).read(locator))?.composer, composer);
    } finally {
        await f.cleanup();
    }
});

test("corruption preserves private recovery bytes and a visible notice across subsequent restarts", async () => {
    const f = await fixture();
    try {
        const damaged = '{"version":1,"private":"unfinished';
        await writeFile(f.store.path, damaged, { mode: 0o644 });
        const recovered = await DesktopDraftStore.open(f.root);
        match(recovered.notice, /private recovery copy was preserved/);
        const [copy] = (await readdir(recovered.directory)).filter((name) => name.startsWith("drafts-corrupt-"));
        ok(copy);
        equal(await readFile(join(recovered.directory, copy), "utf8"), damaged);
        if (process.platform !== "win32") equal((await stat(join(recovered.directory, copy))).mode & 0o777, 0o600);
        equal((await DesktopDraftStore.open(f.root)).notice, recovered.notice);
        await recovered.write(locator, composer);
        deepEqual((await (await DesktopDraftStore.open(f.root)).read(locator))?.composer, composer);
    } finally {
        await f.cleanup();
    }
});

test("bootstrap acceptance retirement follows durable identity and replacement wire without reviving delayed input", async () => {
    const f = await fixture();
    try {
        const fresh = { ...locator, durableSessionId: "" };
        await f.store.write(fresh, composer);
        await f.store.accepted(fresh, composer.requestId);
        await f.store.bind(locator);
        const replacement = { ...locator, composerKey: "replacement-wire" };
        await f.store.restoreBinding(locator, replacement);
        const reopened = await DesktopDraftStore.open(f.root);
        for (const location of [fresh, locator, replacement]) {
            await reopened.write(location, composer);
            await reopened.queue(location, { text: composer.text, requestId: composer.requestId, images: [] });
            await rejects(
                () =>
                    reopened.submit(location, {
                        text: composer.text,
                        requestId: composer.requestId,
                        images: [],
                        kind: "bootstrap",
                        expectedGeneration: 0,
                    }),
                /accepted or discarded/,
            );
        }
        deepEqual(await reopened.list(), []);
        const other = { ...locator, durableSessionId: "unrelated-session" };
        await reopened.write(other, composer);
        deepEqual((await reopened.read(other))?.composer, composer);
    } finally {
        await f.cleanup();
    }
});

test("discarding the composer preserves separate queued and submitted intent across restart", async () => {
    const f = await fixture();
    try {
        const queued = {
            requestId: "separate-queue",
            text: "Keep queued image",
            images: [{ mimeType: "image/png", base64: "YWJj" }],
        };
        const submitted = {
            ...queued,
            requestId: "separate-submission",
            kind: "prompt" as const,
            expectedGeneration: 3,
        };
        await f.store.queue(locator, queued);
        await f.store.submit(locator, submitted);
        await f.store.write(locator, composer);
        await f.store.discard(locator);
        const reopened = await DesktopDraftStore.open(f.root);
        const entry = await reopened.read(locator);
        equal(entry?.composer, null);
        deepEqual(entry?.queued, [queued]);
        deepEqual(entry?.submitted, [submitted]);
        await reopened.write(locator, composer);
        equal((await reopened.read(locator))?.composer, null, "delayed discarded composer writes stay retired");
        await rejects(
            () => reopened.submit(locator, { ...submitted, requestId: composer.requestId }),
            /retired|discarded|accepted/i,
        );
    } finally {
        await f.cleanup();
    }
});
