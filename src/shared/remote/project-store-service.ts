import { PreparedProjectStore, type HomeProjectOwner } from "../../plan-store/index.ts";
import {
    readProjectStoreBody,
    sameProjectStoreBinding,
    validateProjectStoreRequest,
    PROJECT_STORE_MAX_BYTES,
    type ProjectStoreRequest,
} from "./project-store-protocol.ts";

export class LaptopProjectStoreService {
    private readonly owner: PreparedProjectStore;
    constructor(cwd: string | HomeProjectOwner) {
        this.owner = new PreparedProjectStore(cwd);
    }
    get binding() {
        return this.owner.binding;
    }
    async handle(request: Request, admitted: () => boolean): Promise<Response> {
        if (!admitted()) return new Response(null, { status: 403 });
        if (request.method !== "POST") return new Response(null, { status: 405 });
        let input: ProjectStoreRequest;
        try {
            input = JSON.parse(await readProjectStoreBody(request));
            validateProjectStoreRequest(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (!admitted() || !sameProjectStoreBinding(input.binding, this.owner.binding))
            return new Response(null, { status: 403 });
        try {
            const result = JSON.stringify(await this.owner.execute(input.command));
            if (new TextEncoder().encode(result).length > PROJECT_STORE_MAX_BYTES)
                return new Response(null, { status: 413 });
            return new Response(result, { headers: { "Content-Type": "application/json" } });
        } catch {
            return new Response(null, { status: 409 });
        }
    }
}
