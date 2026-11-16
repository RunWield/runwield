import { _electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
    desktopBuild,
    desktopElectron,
    desktopRoot,
    requireDesktopArtifacts,
} from "../../../../scripts/desktop-paths.ts";
import type { makeSessionProcessFixture } from "../../../acp/client/testing/session-process-fixture.ts";

type SessionFixture = Awaited<ReturnType<typeof makeSessionProcessFixture>>;
export async function launchDesktop(fixture: SessionFixture, options: { entry?: boolean } = {}) {
    await requireDesktopArtifacts();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({
        ...fixture.env,
        DISPLAY: process.env.DISPLAY,
        XAUTHORITY: process.env.XAUTHORITY,
    }))
        if (typeof value === "string") env[key] = value;
    const application = await _electron.launch({
        executablePath: (await desktopElectron()).executable,
        args: [
            `--user-data-dir=${join(fixture.home, "electron-profile")}`,
            join(desktopBuild, "main.mjs"),
            ...(options.entry ? [] : ["--project", fixture.project]),
            "--bun",
            fixture.bunExecutable,
            "--cli",
            fixture.sourceCliPath,
            "--hidden",
        ],
        cwd: desktopRoot,
        env,
        chromiumSandbox: true,
        bypassCSP: false,
        timeout: 20000,
    });
    let diagnostics = "";
    application
        .process()
        .stderr?.setEncoding("utf8")
        .on("data", (text: string) => {
            diagnostics = (diagnostics + text).slice(-32000);
        });
    const sourceChildren = () =>
        execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
            .split("\n")
            .filter(
                (line) =>
                    Number(line.trim().split(/\s+/)[1]) === application.process().pid &&
                    line.includes(fixture.sourceCliPath) &&
                    line.trim().endsWith(" acp"),
            )
            .map((line) => Number(line.trim().split(/\s+/)[0]));
    let closed = false;
    async function close() {
        if (closed) return;
        closed = true;
        let timer: ReturnType<typeof setTimeout>;
        try {
            await Promise.race([
                application.close(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("Electron did not close after Session settlement.")),
                        12000,
                    );
                }),
            ]);
        } catch (error) {
            console.error(diagnostics);
            for (const pid of sourceChildren()) process.kill(pid, "SIGKILL");
            application.process().kill("SIGKILL");
            throw error;
        } finally {
            clearTimeout(timer!);
        }
    }
    try {
        const page = await application.firstWindow({ timeout: 20000 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        await page.getByRole("button", { name: "Open Project", exact: true }).waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: "Open Project", exact: true }).waitFor({ state: "visible" });
        await page.waitForFunction(
            () => !document.querySelector<HTMLButtonElement>(".project-entry header button")?.disabled,
        );
        if (!options.entry) {
            await page.getByRole("button", { name: "Link Project", exact: true }).click();
            await page.getByRole("button", { name: "Open", exact: true }).click();
            await page.getByText("No Session open", { exact: true }).waitFor();
        }
        const [runtimePid] = sourceChildren();
        if (!runtimePid)
            throw new Error(`No source ACP child of Electron PID ${application.process().pid}. ${diagnostics}`);
        return { application, page, runtimePid, errors, diagnostics: () => diagnostics, close };
    } catch (error) {
        try {
            await close();
        } finally {
            console.error(diagnostics);
        }
        throw error;
    }
}
