import { ProjectStoreClient } from "./project-store-client.ts";
import type { ProjectStoreRequest } from "./project-store-protocol.ts";
const [endpoint, credential, json] = process.argv.slice(2);
const request: ProjectStoreRequest = JSON.parse(json);
console.log(
    JSON.stringify(await new ProjectStoreClient(endpoint, credential, request.binding).execute(request.command)),
);
