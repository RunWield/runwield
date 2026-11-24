import { equal, throws } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { projects } from "@runwield/projects";
import { registerFactoryProject } from "./project.ts";

test("Factory provisioning reuses the registered Project and refuses an inactive registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-checkout-"));
    const registry = projects.registrations.open();
    try {
        const { projectId } = registry.register({ root });
        equal(registerFactoryProject(root), projectId);
        registry.setStatus(projectId, "inactive");
        throws(() => registerFactoryProject(root), /inactive/);
        equal(registry.get(projectId)?.status, "inactive");
    } finally {
        registry.close();
        await rm(root, { recursive: true, force: true });
    }
});
