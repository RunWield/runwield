export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

// Publication workers use an explicit identity and configuration, not the user's Git preferences.
const gitEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Publication Worker",
    GIT_AUTHOR_EMAIL: "publication@example.test",
    GIT_COMMITTER_NAME: "Publication Worker",
    GIT_COMMITTER_EMAIL: "publication@example.test",
};

export function gitResult(workspace: string, args: string[]): GitResult {
    const result = Bun.spawnSync(["git", "-c", "commit.gpgSign=false", "-c", "core.autocrlf=false", ...args], {
        cwd: workspace,
        env: gitEnvironment,
    });
    if (result.error) throw result.error;
    return {
        code: result.exitCode,
        stdout: result.stdout.toString().trim(),
        stderr: result.stderr.toString().trim(),
    };
}

export function git(workspace: string, args: string[]): string {
    const result = gitResult(workspace, args);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
}
