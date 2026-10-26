/** Real child-process failure scenarios. Never run inside the test runner. */
import process from "node:process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { superviseRuntime } from "../runtime-supervisor.ts";

const mode = process.argv[2];
if (process.platform === "linux" && ["abort", "image-exhaustion", "tty-image-exhaustion"].includes(mode)) {
    // Piped core collectors can ignore RLIMIT_CORE. Change only this intentional crash process.
    const { dlopen } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
        prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    });
    try {
        const PR_SET_DUMPABLE = 4;
        if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
            throw new Error("Cannot disable core dumps in the native crash fixture");
        }
    } finally {
        libc.close();
    }
    console.error("Native crash fixture:", process.pid, readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim());
}
if (mode === "image-exhaustion" || mode === "supervisor-exhaustion" || mode === "tty-image-exhaustion") {
    if (mode === "tty-image-exhaustion") {
        process.stdin.setRawMode(true);
        process.stdout.write("\x1b[?1049h\x1b[?2004h\x1b[?25l");
    }
    const descriptors: number[] = [];
    try {
        while (true) descriptors.push(openSync(process.platform === "win32" ? "NUL" : "/dev/null", "r"));
    } catch {
        // Hold the descriptors while Pi tries to start its real image worker.
    }
    try {
        const png =
            "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg==";
        if (mode === "supervisor-exhaustion") {
            process.exitCode = await superviseRuntime(process.execPath, ["--version"]);
        } else {
            await resizeImage(Buffer.from(png, "base64"), "image/png", { maxWidth: 2, maxHeight: 2 });
        }
    } finally {
        for (const descriptor of descriptors) closeSync(descriptor);
    }
} else if (mode === "stdio") {
    for await (const chunk of process.stdin) process.stdout.write(chunk);
    process.stderr.write("child diagnostic\n");
} else if (mode === "resource-error") {
    console.log("attempt");
    throw Object.assign(new Error("Cannot start an operation"), { code: "EMFILE" });
} else if (mode === "abort") {
    process.abort();
} else if (mode === "recovered-resource") {
    console.error("EMFILE: recovered earlier");
    console.error("ordinary failure");
    process.exit(17);
} else if (mode === "large-stderr") {
    process.stderr.write("x".repeat(512_000), () => process.exit(17));
} else if (mode === "service" || mode === "service-resource-error") {
    const serviceLifetime = mode === "service-resource-error" ? 30_000 : 5000;
    const service = spawn(process.execPath, ["--eval", `setTimeout(() => {}, ${serviceLifetime})`], {
        stdio: ["ignore", "ignore", "inherit"],
        detached: true,
    });
    console.log(service.pid);
    service.unref();
    if (mode === "service-resource-error") {
        await new Promise<void>((resolve) => process.stderr.write("x".repeat(64_000), () => resolve()));
        while (!existsSync(process.argv[3])) await new Promise((resolve) => setTimeout(resolve, 5));
        process.stderr.write("\nfatal error: EMFILE: too many open files\n", () => process.exit(17));
    }
} else if (mode === "signal") {
    process.on("SIGTERM", () => process.exit(23));
    console.log("READY");
    setInterval(() => {}, 1000);
} else if (mode === "exit") {
    console.error("ordinary failure");
    process.exit(17);
} else {
    throw new Error(`Unknown supervisor fixture: ${mode}`);
}
