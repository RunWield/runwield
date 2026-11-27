import { authenticatedProjectStoreRequest } from "./project-store-request.ts";
/** Bounded real-process fixture for project-store.integration.test.ts; not a production launcher. */
import { type HomeProjectOwner } from "@runwield/projects";
import { startRemoteControlService } from "./control.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
import type { ProjectStoreBinding } from "@runwield/plans/project-store-wire";
import type { ProjectStoreCommand } from "../../plan-store/index.ts";
const mode = process.argv[2];
if (mode === "owner") {
    const service = startRemoteControlService({ buildId: "a".repeat(64), protocol: 1 });
    const registration: string | HomeProjectOwner = process.argv[3]!.startsWith("{")
        ? JSON.parse(process.argv[3]!)
        : process.argv[3]!;
    const binding = service.registerProjectStore(registration);
    process.stdout.write(`${JSON.stringify({ port: service.port, credential: service.credential, binding })}\n`);
    for await (const chunk of process.stdin) {
        if (chunk.toString().includes("close")) break;
    }
    await service.close();
} else if (mode === "client") {
    const input: { endpoint: string; credential: string; binding: ProjectStoreBinding; command: ProjectStoreCommand } =
        JSON.parse(process.argv[3]!);
    const client = new ProjectStoreClient(
        authenticatedProjectStoreRequest(input.endpoint, input.credential),
        input.binding,
    );
    process.stdout.write(`${JSON.stringify(await client.execute(input.command))}\n`);
} else throw new Error("Expected owner or client fixture mode.");
