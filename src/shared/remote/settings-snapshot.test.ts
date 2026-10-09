import { fileURLToPath } from "node:url";
import { copyFile, rename } from "node:fs/promises";
import { spawnNativeProcess } from "../foreground-process.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { serveHttp } from "../http-server.ts";
import process from "node:process";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { __resetSettingsForTests, getCustomSetting, getSettingsManager, setCustomSetting } from "../settings.js";
import { configureRemotePersonalResources, PersonalResourcePathError } from "./personal-resources.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";

test("remote synchronous settings refresh after a lost acknowledgement and an unrelated laptop write", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const project = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const mounted = join(home, "mount");
        const previous = process.env["HOME"];
        process.env["HOME"] = home;
        await fsMkdir(join(home, ".wld"));
        await fsMkdir(mounted);
        const laptopPath = join(home, ".wld", "settings.json");
        const mountedPath = join(mounted, "settings.json");
        await fsWriteFile(laptopPath, JSON.stringify({ theme: "dark", other: 1 }));
        await copyFile(laptopPath, mountedPath);
        await fsMkdir(join(project, ".wld"));
        await fsWriteFile(
            join(project, ".wld", "settings.json"),
            JSON.stringify({ defaultProvider: "project-provider" }),
        );
        const service = spawnNativeProcess(process.execPath, {
            cwd: getCwd(),
            args: ["run", ...[], fileURLToPath(new URL("./settings-service-fixture.ts", import.meta.url))],
            env: { HOME: home },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        const reader = service.stdout.getReader();
        let line = "";
        while (!line.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Settings service did not start");
            line += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        const connection: { port: number; credential: string } = JSON.parse(line.split("\n")[0]);
        const address = `http://127.0.0.1:${connection.port}`;
        const headers = { Authorization: `Bearer ${connection.credential}` };
        let dropped = 0;
        const writeOnLaptop = async () => {
            const result = await captureForegroundProcess(process.execPath, {
                cwd: getCwd(),
                args: ["run", ...[], fileURLToPath(new URL("./settings-service-fixture.ts", import.meta.url)), "write"],
                env: { HOME: home },
            });
            if (result.code !== 0) throw new Error(new TextDecoder().decode(result.stderr));
        };
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const path = new URL(request.url).pathname;
            const response = await fetch(`${address}${path}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
            });
            if (path === "/settings/update" && dropped++ < 2) {
                await response.arrayBuffer(); // Laptop committed the update, but its acknowledgement was lost.
                if (dropped === 1) await writeOnLaptop(); // Concurrent laptop writer before replay.
                return new Response(null, { status: 503 });
            }
            return response;
        });
        try {
            const identity = { buildId: "b".repeat(64), protocol: 1 };
            assertEquals(
                (
                    await fetch(`${address}/handshake`, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(identity),
                    })
                ).status,
                200,
            );
            assertEquals((await fetch(`${address}/readiness`, { method: "POST", headers })).status, 200);
            const port = proxy.addr;
            if (port.transport !== "tcp") throw new Error("Expected TCP");
            configureRemotePersonalResources({ globalRoot: mounted });
            configureRemoteSettingsConnection({ port: port.port, credential: connection.credential });
            const manager = getSettingsManager(project);
            const readTheme = manager.getTheme;
            assertEquals(manager.getTheme(), "dark");
            assertEquals(manager.getDefaultProvider(), "project-provider");
            // A healthy mount may not have a settings file yet.
            await fsRm(mountedPath);
            assertEquals(getCustomSetting("theme", "global", project), undefined);
            assertEquals(manager.getTheme(), undefined);
            await copyFile(laptopPath, mountedPath);
            assertEquals(manager.getTheme(), "dark");
            await setCustomSetting("marker", "remote", "global", project);
            assertEquals(getCustomSetting("marker", "global", project), "remote");
            assertEquals(manager.getTheme(), "dark");
            // The receipt is older than the laptop's independent write; the mount catches up.
            await copyFile(laptopPath, mountedPath);
            assertEquals(getCustomSetting("marker", "global", project), "remote");
            assertEquals(readTheme(), "light");
            assertEquals(manager.getTheme(), "light");
            assertEquals(manager.getDefaultProvider(), "project-provider");
            assertEquals(getSettingsManager(project), manager);
            assertEquals(getCustomSetting("other", "global", project), 1);
            assertEquals(dropped, 2);
            // The settings command gets a laptop receipt before the mount catches up.
            await setCustomSetting("theme", "mono", "global", project);
            assertEquals(manager.getTheme(), "mono");
            assertEquals(manager.getDefaultProvider(), "project-provider");
            await setCustomSetting("theme", "project-theme", "project", project);
            assertEquals(manager.getTheme(), "project-theme");
            await fsWriteFile(mountedPath, JSON.stringify({ theme: "new-laptop-theme" }));
            assertEquals(manager.getTheme(), "project-theme");
            // A vanished mount cannot return the held manager's old personal values.
            const mountedIdentity = await fsStat(mounted, { bigint: true });
            await rename(mounted, join(home, "detached-mount"));
            assertThrows(() => manager.getTheme(), PersonalResourcePathError);
            assertThrows(() => getSettingsManager(project), PersonalResourcePathError);
            // SSHFS can detach and leave its sealed local directory behind.
            await fsMkdir(mounted);
            await fsChmod(mounted, 0o500);
            const detachedIdentity = await fsStat(mounted, { bigint: true });
            assertEquals(detachedIdentity.dev, mountedIdentity.dev);
            if (detachedIdentity.ino === mountedIdentity.ino) throw new Error("Replacement must have a new inode");
            assertThrows(() => getCustomSetting("theme", "global", project), PersonalResourcePathError);
            assertThrows(() => manager.getTheme(), PersonalResourcePathError);
            assertThrows(() => getSettingsManager(project), PersonalResourcePathError);
            await fsChmod(mounted, 0o700);
            await fsWriteFile(mountedPath, JSON.stringify({ theme: "remote-account-theme" }));
            await fsChmod(mounted, 0o500);
            assertThrows(() => getCustomSetting("theme", "global", project), PersonalResourcePathError);
        } finally {
            await proxy.shutdown();
            await service.stdin.close();
            await service.status;
            __resetSettingsForTests();
            if (previous === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previous;
            await fsChmod(mounted, 0o700).catch(() => {});
            await fsRm(home, { recursive: true });
            await fsRm(project, { recursive: true });
        }
    });
});
