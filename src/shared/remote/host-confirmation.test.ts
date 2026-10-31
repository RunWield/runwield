import { deepStrictEqual as equal, match, throws } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    ensureRemoteProject,
    listProjectsFromDisk,
    recordRemoteHostAnswer,
    sessionDirForProject,
} from "../session/file-session-storage.ts";
import { confirmRemoteHost } from "./host-confirmation.ts";
import { LaptopSessionControl } from "./laptop-session-control.ts";
import { bindRemoteMemory, remoteMemoryIdentity } from "./memory-binding.ts";
import type { ResolvedRemoteTarget } from "./target.ts";

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void> | void) {
    await withProcessGlobalTestLock(async () => {
        const f = await setup();
        const prompt = globalThis.prompt;
        globalThis.prompt = () => {
            throw new Error("Unexpected host question");
        };
        try {
            await run(f);
        } finally {
            globalThis.prompt = prompt;
            await rm(f.baseDir, { recursive: true });
        }
    });
}

async function setup() {
    const baseDir = await mkdtemp(join(tmpdir(), "host-confirmation-"));
    const target: ResolvedRemoteTarget = {
        host: { hostname: "saved.example", user: "dev", port: 22, hostKeyFingerprint: "SHA256:original" },
        cwd: "/srv/project/worktree",
        home: "/home/dev",
        os: "Linux",
        arch: "x86_64",
        primaryRoot: "/srv/project",
        gitRoot: "/srv/project/worktree",
        gitDir: "/srv/project/.git/worktrees/feature",
        gitCommonDir: "/srv/project/.git",
        isWorktree: true,
    };
    const project = ensureRemoteProject(baseDir, target.host, target, undefined, "saved:/srv/project");
    const address = { ...target, host: { ...target.host, hostname: "192.0.2.1" } };
    const key = { ...target, host: { ...target.host, hostKeyFingerprint: "SHA256:replacement" } };
    const projectFile = join(sessionDirForProject(baseDir, project), ".runwield", "project.json");
    return { baseDir, target, project, projectFile, address, key };
}

async function saveSession(baseDir: string, target: ResolvedRemoteTarget) {
    const control = new LaptopSessionControl({ baseDir, target, targetLabel: "saved:/srv/project" });
    const sessionId = crypto.randomUUID();
    try {
        const { operation } = await control.handle({
            kind: "create",
            sessionId,
            name: "",
            admissionId: crypto.randomUUID(),
        });
        control.handleSave({ operation: operation!, sequence: 0, kind: "hydrate", contents: "" });
        control.handleSave({
            operation: operation!,
            sequence: 1,
            kind: "append",
            contents:
                JSON.stringify({
                    type: "message",
                    id: "user-1",
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "Saved host sentinel" }],
                        timestamp: Date.now(),
                    },
                }) + "\n",
        });
        await control.handle({ kind: "checkpoint", operation: operation! });
    } finally {
        control.close();
    }
    return sessionId;
}

for (const change of ["address", "key"] as const) {
    test(`Yes for a ${change} change restores saved history and is retained`, () =>
        fixture(async (f) => {
            const sessionId = await saveSession(f.baseDir, f.target);
            let question = "";
            globalThis.prompt = (text) => {
                question = text || "";
                return "1";
            };
            const confirmed = confirmRemoteHost(f[change], f.baseDir);
            equal(confirmed, { ...f[change], host: f.target.host });
            match(question, /saved:\/srv\/project — dev@saved\.example:22/);
            if (change === "key") {
                match(question, /Host key changed from SHA256:original to SHA256:replacement/);
                match(question, /OpenSSH accepted the new key/);
            } else match(question, /Same host key SHA256:original; hostname or port changed/);
            equal(ensureRemoteProject(f.baseDir, confirmed.host, confirmed).projectId, f.project.projectId);
            equal(remoteMemoryIdentity(confirmed), remoteMemoryIdentity(f.target));
            equal(await bindRemoteMemory(confirmed), await bindRemoteMemory(f.target));
            const control = new LaptopSessionControl({ baseDir: f.baseDir, target: confirmed, targetLabel: "new" });
            try {
                const { sessions } = await control.handle({ kind: "list" });
                equal(
                    sessions?.map((session) => [session.id, session.firstMessage]),
                    [[sessionId, "Saved host sentinel"]],
                );
                const { operation } = await control.handle({
                    kind: "begin",
                    sessionId,
                    admissionId: crypto.randomUUID(),
                });
                const saved = await control.handleSave({
                    operation: operation!,
                    sequence: 0,
                    kind: "hydrate",
                    contents: "",
                });
                match(saved.contents || "", /Saved host sentinel/);
                await control.handle({ kind: "checkpoint", operation: operation! });
            } finally {
                control.close();
            }
            const bytes = await readFile(f.projectFile, "utf8");
            globalThis.prompt = () => {
                throw new Error("Asked twice");
            };
            equal(confirmRemoteHost(f[change], f.baseDir), confirmed);
            equal(await readFile(f.projectFile, "utf8"), bytes);
        }));

    test(`No for a ${change} change keeps a separate project and is retained before any new Session`, () =>
        fixture(async (f) => {
            await saveSession(f.baseDir, f.target);
            globalThis.prompt = () => "0";
            equal(confirmRemoteHost(f[change], f.baseDir), f[change]);
            globalThis.prompt = () => {
                throw new Error("Asked twice");
            };
            equal(confirmRemoteHost(f[change], f.baseDir), f[change]);
            const control = new LaptopSessionControl({ baseDir: f.baseDir, target: f[change], targetLabel: "new" });
            try {
                equal(await control.handle({ kind: "list" }), { sessions: [] });
            } finally {
                control.close();
            }
            const separate = ensureRemoteProject(f.baseDir, f[change].host, f[change]);
            equal(separate.projectId === f.project.projectId, false);
            equal(confirmRemoteHost(f[change], f.baseDir), f[change]);
        }));
}

test("exact identity and execution cwd changes need no consent or writes", () =>
    fixture(async (f) => {
        const bytes = await readFile(f.projectFile, "utf8");
        const target = { ...f.target, cwd: "/srv/project/another-worktree" };
        equal(confirmRemoteHost(target, f.baseDir), target);
        equal(await readFile(f.projectFile, "utf8"), bytes);
    }));

for (const kind of ["user", "root", "address-and-key", "port-and-key", "unknown"] as const) {
    test(`${kind} difference never asks or reuses history`, () =>
        fixture(async (f) => {
            const observed = {
                ...f.target,
                host: { ...f.target.host },
            };
            if (kind === "user") {
                observed.host.user = "other";
                observed.host.hostname = f.address.host.hostname;
            }
            if (kind === "root") {
                observed.primaryRoot = "/srv/other";
                observed.host.hostname = f.address.host.hostname;
            }
            if (kind === "address-and-key") observed.host.hostname = "elsewhere.example";
            if (kind === "port-and-key") observed.host.port = 2222;
            if (["address-and-key", "port-and-key"].includes(kind)) observed.host.hostKeyFingerprint = "SHA256:other";
            if (kind === "unknown") await rm(sessionDirForProject(f.baseDir, f.project), { recursive: true });
            const before = listProjectsFromDisk(f.baseDir);
            equal(confirmRemoteHost(observed, f.baseDir), observed);
            equal(listProjectsFromDisk(f.baseDir), before);
        }));
}

test("two unknown fingerprints do not prove a shared server", () =>
    fixture((f) => {
        const certificate = { ...f.target, host: { ...f.target.host, hostKeyFingerprint: null } };
        const baseDir = join(f.baseDir, "certificates");
        ensureRemoteProject(baseDir, certificate.host, certificate);
        const observed = { ...certificate, host: { ...certificate.host, hostname: "other.example" } };
        equal(confirmRemoteHost(observed, baseDir), observed);
        equal(confirmRemoteHost(certificate, baseDir), certificate);
    }));

for (const kind of ["port", "case", "certificate"] as const) {
    test(`${kind} changes ask for confirmation`, () =>
        fixture((f) => {
            const observed = { ...f.target, host: { ...f.target.host } };
            if (kind === "port") observed.host.port = 2222;
            if (kind === "case") observed.host.hostname = "SAVED.example";
            if (kind === "certificate") observed.host.hostKeyFingerprint = null;
            globalThis.prompt = (question) => {
                match(question || "", kind === "certificate" ? /Host key changed/ : /hostname or port changed/);
                return "1";
            };
            equal(confirmRemoteHost(observed, f.baseDir).host, f.target.host);
        }));
}

test("a key change after an accepted address change finds the same project", () =>
    fixture((f) => {
        globalThis.prompt = () => "1";
        confirmRemoteHost(f.address, f.baseDir);
        const observed = { ...f.address, host: { ...f.address.host, hostKeyFingerprint: "SHA256:third" } };
        globalThis.prompt = (question) => {
            match(question || "", /Host key changed from SHA256:original to SHA256:third/);
            return "1";
        };
        equal(confirmRemoteHost(observed, f.baseDir).host, f.target.host);
    }));

for (const answer of [null, "", "x", "-1", "1.5", "2", "99999999999999999999999999"]) {
    test(`answer ${JSON.stringify(answer)} stops startup without saving a decision`, () =>
        fixture(async (f) => {
            const bytes = await readFile(f.projectFile, "utf8");
            globalThis.prompt = () => answer;
            throws(() => confirmRemoteHost(f.address, f.baseDir), {
                message: answer === null ? "Remote host choice canceled" : "Invalid remote host choice",
            });
            equal(await readFile(f.projectFile, "utf8"), bytes);
        }));
}

for (const choice of ["0", "2"]) {
    test(`several candidates retain choice ${choice} for the correct projects`, () =>
        fixture((f) => {
            const second = { ...f.target, host: { ...f.target.host, hostname: "second.example" } };
            const project = ensureRemoteProject(f.baseDir, second.host, second, undefined, "second:/srv/project");
            globalThis.prompt = (question) => {
                match(question || "", /1\. saved:/);
                match(question || "", /2\. second:/);
                return choice;
            };
            const result = confirmRemoteHost(f.address, f.baseDir);
            equal(result.host, choice === "2" ? second.host : f.address.host);
            const saved = listProjectsFromDisk(f.baseDir);
            if (choice === "2") {
                equal(saved.find((item) => item.projectId === f.project.projectId)?.remote?.acceptedHosts, undefined);
                equal(saved.find((item) => item.projectId === project.projectId)?.remote?.acceptedHosts, [
                    f.address.host,
                ]);
            } else
                equal(
                    saved.map((item) => item.remote?.refusedHosts),
                    [[f.address.host], [f.address.host]],
                );
            globalThis.prompt = () => {
                throw new Error("Asked twice");
            };
            equal(confirmRemoteHost(f.address, f.baseDir), result);
        }));
}

test("retaining a duplicate answer leaves the project identity and bytes unchanged", () =>
    fixture(async (f) => {
        recordRemoteHostAnswer(f.baseDir, f.project, f.address.host, "acceptedHosts");
        const bytes = await readFile(f.projectFile, "utf8");
        recordRemoteHostAnswer(f.baseDir, f.project, f.address.host, "acceptedHosts");
        equal(await readFile(f.projectFile, "utf8"), bytes);
        const saved = listProjectsFromDisk(f.baseDir)[0];
        equal(saved.projectId, f.project.projectId);
        equal(saved.remote, { ...f.project.remote, acceptedHosts: [f.address.host] });
    }));
