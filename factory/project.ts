import { projects, type ProjectId } from "@runwield/projects";
import { resolve } from "node:path";

/** Deliberate provisioning uses the same checkout admission as Workspace. */
export function registerFactoryProject(root: string): ProjectId {
    const registry = projects.registrations.open();
    try {
        const { projectId } = registry.register({ root: resolve(root) });
        registry.requireActiveRoot(projectId);
        const checkout = projects.checkout.inspect(root);
        if (checkout.kind !== "existing" || checkout.identity.projectId !== projectId) {
            throw new Error("The Factory checkout does not match its registered Project.");
        }
        return projectId;
    } finally {
        registry.close();
    }
}

export async function deployedFactoryProject(namespace: string, root: string): Promise<ProjectId> {
    const checkout = projects.checkout.inspect(resolve(root));
    if (checkout.kind !== "existing") throw new Error("Select the checkout of a registered Factory Project.");
    const id = checkout.identity.projectId;
    const registry = projects.registrations.open();
    try {
        registry.requireActiveRoot(id);
    } finally {
        registry.close();
    }
    const child = Bun.spawn(
        [
            "kubectl",
            "-n",
            namespace,
            "get",
            "configmap",
            `factory-project-${id.toLowerCase()}`,
            "-o",
            'jsonpath={.immutable}{" "}{.data.projectId}',
        ],
        {
            stdout: "pipe",
            stderr: "inherit",
        },
    );
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0 || output !== `true ${id}`) {
        throw new Error("Factory Project binding is missing, mutable, or bound to a different Project.");
    }
    return id;
}

if (import.meta.main) {
    const namespace = process.env.FACTORY_NAMESPACE || "runwield-personal";
    const root = process.env.FACTORY_PROJECT_ROOT || process.cwd();
    if (process.argv[2] === "--print-id") {
        console.log(await deployedFactoryProject(namespace, root));
        process.exit(0);
    }
    const projectId = registerFactoryProject(root);
    const manifest = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: `factory-project-${projectId.toLowerCase()}`, namespace },
        immutable: true,
        data: { projectId },
    };
    const child = Bun.spawn(["kubectl", "apply", "--server-side", "--field-manager=runwield-factory", "-f", "-"], {
        stdin: new Blob([JSON.stringify(manifest)]),
        stdout: "inherit",
        stderr: "inherit",
    });
    if (await child.exited) throw new Error("Could not provision the registered Factory Project.");
    console.log(`Factory Project ${projectId} in ${namespace}`);
}
