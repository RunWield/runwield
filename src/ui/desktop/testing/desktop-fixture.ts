import { _electron } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import {
    desktopBuild,
    desktopElectron,
    desktopRoot,
    requireDesktopArtifacts,
} from "../../../../scripts/desktop-paths.ts";
import type { makeSessionProcessFixture } from "../../../acp/client/testing/session-process-fixture.ts";

const orphanCandidatesByHome = new Map<string, Set<number>>();

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
    const executablePath = (await desktopElectron()).executable;
    const args = [
        `--user-data-dir=${join(fixture.home, "electron-profile")}`,
        join(desktopBuild, "main.mjs"),
        ...(options.entry ? [] : ["--project", fixture.project]),
        "--bun",
        fixture.bunExecutable,
        "--cli",
        fixture.sourceCliPath,
        "--hidden",
    ];
    const application = await _electron.launch({
        executablePath,
        args,
        cwd: desktopRoot,
        env,
        chromiumSandbox: true,
        bypassCSP: false,
        timeout: 20000,
    });
    const mainProcess = application.process();
    let diagnostics = "";
    application
        .process()
        .stderr?.setEncoding("utf8")
        .on("data", (text: string) => {
            diagnostics = (diagnostics + text).slice(-32000);
        });
    const sourceChildren = () => {
        const rows = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
            .split("\n")
            .map((line) => {
                const [pid, parent] = line.trim().split(/\s+/);
                return { pid: Number(pid), parent: Number(parent), command: line };
            });
        const owned = new Set(
            rows
                .filter(
                    (row) =>
                        row.parent === mainProcess.pid &&
                        row.command.includes(fixture.sourceCliPath) &&
                        row.command.trim().endsWith(" acp"),
                )
                .map((row) => row.pid),
        );
        // Include real Background Task subprocesses before their owner can die and reparent them.
        let changed = true;
        while (changed) {
            changed = false;
            for (const row of rows)
                if (owned.has(row.parent) && !owned.has(row.pid)) {
                    owned.add(row.pid);
                    changed = true;
                }
        }
        return [...owned];
    };
    const knownChildren = new Set<number>();
    const orphanCandidates = orphanCandidatesByHome.get(fixture.home) || new Set<number>();
    orphanCandidatesByHome.set(fixture.home, orphanCandidates);
    const trackChildren = () => {
        for (const pid of sourceChildren()) knownChildren.add(pid);
    };
    const tracker = setInterval(trackChildren, 100);
    mainProcess.once("exit", () => clearInterval(tracker));
    function killChildren() {
        for (const pid of new Set([...knownChildren, ...orphanCandidates])) {
            try {
                process.kill(pid, "SIGKILL");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
        }
    }
    let closed = false;
    async function close() {
        if (closed) {
            clearInterval(tracker);
            killChildren();
            return;
        }
        trackChildren();
        closed = true;
        // Native dialog is the external boundary. Cleanup chooses Stop, not a weaker production path.
        await application
            .evaluate(({ dialog }) => {
                dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
            })
            .catch(() => {});
        const mainExited =
            mainProcess.exitCode !== null || mainProcess.signalCode !== null
                ? Promise.resolve()
                : new Promise<void>((resolve) => mainProcess.once("exit", () => resolve()));
        let timer: ReturnType<typeof setTimeout>;
        try {
            // Playwright's application.close() disconnects the debugger before Quit settles.
            // Keep the real renderer alive to acknowledge its draft flush, as native Quit does.
            await application.evaluate(({ app }) => app.quit()).catch(() => {});
            await Promise.race([
                mainExited,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("Electron did not close after Session settlement.")),
                        12000,
                    );
                }),
            ]);
        } catch (error) {
            console.error(diagnostics);
            mainProcess.kill("SIGKILL");
            throw error;
        } finally {
            clearTimeout(timer!);
            clearInterval(tracker);
            killChildren();
        }
    }
    try {
        const page = await application.firstWindow({ timeout: 20000 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
        await page.waitForFunction(() => {
            const button = document.querySelector<HTMLButtonElement>(".project-entry header button");
            return button && !button.disabled;
        });
        await page.waitForFunction(() =>
            Boolean(
                document.querySelector(".session-client") ||
                [...document.querySelectorAll("button")].some(
                    (button) =>
                        !button.closest("[hidden]") &&
                        ["Link Project", "Open"].includes(button.textContent?.trim() || ""),
                ),
            ),
        );
        const restored =
            (await page.getByRole("button", { name: "Session", exact: true }).count()) ||
            (await page.locator(".project-session:not([hidden]) .session-client").count());
        if (!options.entry && !restored) {
            const link = page.getByRole("button", { name: "Link Project", exact: true });
            const open = page.getByRole("button", { name: "Open", exact: true });
            await link.or(open).first().waitFor();
            if (await link.isVisible()) await link.click();
            await open.click();
            await page.getByText("No Session open", { exact: true }).waitFor();
        }
        trackChildren();
        const [runtimePid] = sourceChildren();
        if (!runtimePid) throw new Error(`No source ACP child of Electron PID ${mainProcess.pid}. ${diagnostics}`);
        const secondLaunch = async () => {
            const child = spawn(executablePath, args, { cwd: desktopRoot, env, stdio: "ignore" });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                return await new Promise<number | null>((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", resolve);
                    timer = setTimeout(() => reject(new Error("Second desktop instance did not exit.")), 10000);
                });
            } finally {
                clearTimeout(timer);
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }
        };
        const crashMain = async () => {
            if (closed) return;
            closed = true;
            clearInterval(tracker);
            const children = sourceChildren();
            const exited = new Promise<void>((resolve) => mainProcess.once("exit", () => resolve()));
            mainProcess.kill("SIGKILL");
            await exited;
            // Record children before reparenting. Production EOF handling must settle them;
            // only final cleanup may force-kill survivors, so tests can detect orphan work.
            for (const pid of children) {
                knownChildren.add(pid);
                orphanCandidates.add(pid);
            }
            for (const pid of children) {
                let alive = true;
                for (let attempt = 0; attempt < 100; attempt++) {
                    try {
                        process.kill(pid, 0);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                        alive = false;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                if (alive) throw new Error(`Desktop main died but owned subprocess ${pid} is still alive.`);
            }
        };
        return {
            application,
            page,
            runtimePid,
            errors,
            diagnostics: () => diagnostics,
            close,
            secondLaunch,
            crashMain,
        };
    } catch (error) {
        try {
            await close();
        } finally {
            console.error(diagnostics);
        }
        throw error;
    }
}
