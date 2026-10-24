/** Shared user guidance for OS resource failures, including native runtime diagnostics. */
export function resourceExhaustionMessage(error: Error | string): string | null {
    const seen = new Set<Error>();
    let current: Error | string = error;
    while (true) {
        const code = typeof current === "string" ? "" : Reflect.get(current, "code");
        const text = typeof current === "string" ? current : current.message;
        if (
            code === "EMFILE" ||
            code === "ENFILE" ||
            /\b(?:EMFILE|ENFILE)\b|too many open files|out of file descriptors/i.test(text)
        ) {
            return "RunWield reached the open-file limit. Files, sockets, and workers share this limit. Reduce concurrent work or raise the operating system's open-file limit, then retry.";
        }
        if (code === "ENOMEM" || /\bENOMEM\b|out of memory|cannot allocate memory/i.test(text)) {
            return "RunWield could not allocate memory. Stop other memory-intensive work, then retry.";
        }
        if (code === "EAGAIN" || /\bEAGAIN\b|resource temporarily unavailable|pthread_create.*failed/i.test(text)) {
            return "RunWield could not start another process or thread. Reduce concurrent work, then retry.";
        }
        if (typeof current === "string" || seen.has(current)) return null;
        seen.add(current);
        const cause = current.cause;
        if (!(cause instanceof Error) && typeof cause !== "string") return null;
        current = cause;
    }
}
