import { deployedFactoryProject } from "./project.ts";
/** Opt-in live qualification: requires KUBECONFIG, deployed Factory, and model credentials. */
import { strict as assert } from "node:assert";

interface Run {
    metadata: { name: string; uid: string };
    status?: {
        phase?: string;
        executionName?: string;
        result?: {
            operationId: string;
            projectId: string;
            phase: string;
            result: { routingIntent: string; summary: string };
        };
    };
}
interface Pod {
    metadata: { name: string; uid: string };
    status: { phase: string };
}
interface PodList {
    items: Pod[];
}
const namespace = process.env.FACTORY_NAMESPACE || "runwield-personal";
const projectId = await deployedFactoryProject(namespace, process.env.FACTORY_PROJECT_ROOT || process.cwd());

async function kubectl(args: string[], input?: string, allowFailure = false): Promise<string> {
    const process = Bun.spawn(["kubectl", "-n", namespace, ...args], {
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    if (code && !allowFailure) throw new Error(`kubectl ${args.join(" ")}: ${stderr}`);
    return stdout;
}

async function until<T>(description: string, observe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
        const result = await observe();
        if (result !== undefined) return result;
        await Bun.sleep(250);
    }
    throw new Error(`Timed out: ${description}`);
}

async function readRun(name: string): Promise<Run> {
    return JSON.parse(await kubectl(["get", "factoryrun", name, "-o", "json"]));
}

for (const failure of ["none", "process", "pod"] as const) {
    const created: Run = JSON.parse(
        await kubectl(
            ["create", "-f", "-", "-o", "json"],
            JSON.stringify({
                apiVersion: "factory.runwield.dev/v1alpha1",
                kind: "FactoryRun",
                metadata: { generateName: `router-${failure}-`, namespace },
                spec: {
                    projectId,
                    loop: "router",
                    model: process.env.FACTORY_MODEL || "openai/gpt-6.1-sol",
                    input: {
                        prompt: "Explain the difference between a Kubernetes Pod and a Deployment. Information only; do not change files.",
                    },
                },
            }),
        ),
    );
    const name = created.metadata.name;
    let interruptedPod = "";
    if (failure !== "none") {
        const pod = await until("worker admission", async () => {
            const pods: PodList = JSON.parse(
                await kubectl(["get", "pods", "-l", `factory.runwield.dev/run=${name}`, "-o", "json"]),
            );
            const running = pods.items.find((pod) => pod.status.phase === "Running");
            if (!running) return undefined;
            const admitted = await kubectl(
                [
                    "exec",
                    running.metadata.name,
                    "--",
                    "sh",
                    "-c",
                    'for file in /data/home/.wld/factory/*.json; do test -f "$file" && echo admitted; done',
                ],
                undefined,
                true,
            );
            return admitted.includes("admitted") ? running : undefined;
        });
        interruptedPod = pod.metadata.uid;
        if (failure === "pod") {
            await kubectl(["delete", "pod", pod.metadata.name, "--grace-period=0", "--force", "--wait=false"]);
        } else {
            await kubectl([
                "exec",
                pod.metadata.name,
                "--",
                "sh",
                "-c",
                'for dir in /proc/[0-9]*; do read -r name < "$dir/comm" 2>/dev/null || continue; if [ "$name" = wld ]; then kill -9 "${dir##*/}"; echo killed; fi; done',
            ]);
            await kubectl(["rollout", "restart", "deployment/factory-controller"]);
        }
    }
    const completed = await until("completed Router result", async () => {
        const run = await readRun(name);
        return run.status?.phase === "Completed" ? run : undefined;
    });
    assert.equal(completed.status?.result?.operationId, `${created.metadata.uid}:router`);
    assert.equal(completed.status?.result?.projectId, projectId);
    assert.equal(completed.status?.result?.result.routingIntent, "INQUIRY");
    assert.ok(completed.status?.result?.result.summary);
    if (interruptedPod) {
        const pods: PodList = JSON.parse(
            await kubectl(["get", "pods", "-l", `factory.runwield.dev/run=${name}`, "-o", "json"]),
        );
        assert.ok(
            pods.items.some((pod) => pod.metadata.uid !== interruptedPod),
            "a replacement worker must finish the run",
        );
    }
    const worker = `system:serviceaccount:${namespace}:${completed.status?.executionName}`;
    assert.equal((await kubectl(["auth", "can-i", "get", "secrets", `--as=${worker}`], undefined, true)).trim(), "no");
    // `can-i` exits 1 on denial; verify its explicit answer as well as the positive grant.
    assert.equal(
        (
            await kubectl([
                "auth",
                "can-i",
                "patch",
                `stepexecutions/${completed.status?.executionName}`,
                "--subresource=status",
                `--as=${worker}`,
            ])
        ).trim(),
        "yes",
    );
    assert.equal(
        (
            await kubectl(
                ["auth", "can-i", "patch", "stepexecutions/another-run", "--subresource=status", `--as=${worker}`],
                undefined,
                true,
            )
        ).trim(),
        "no",
    );
    console.log(
        `${name}: Completed INQUIRY; failure=${failure}; operation=${created.metadata.uid}:router; worker RBAC checked`,
    );
}
