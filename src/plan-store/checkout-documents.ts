import * as queries from "./queries.ts";

/** Operational documents include Markdown, file locations and evidence used by the Core host. */
export function projectPlanDocuments(read: <Result>(query: (cwd: string) => Promise<Result>) => Promise<Result>) {
    return {
        inspect: (name: string) => read((cwd) => queries.inspectPlanStrict(cwd, name)),
        loadStrict: (name: string) => read((cwd) => queries.loadPlanStrict(cwd, name)),
        load: (name: string) => read((source) => queries.loadPlan(source, name)),
        list: () => read(queries.listPlans),
        evidenceById: (id: string) => read((source) => queries.findPlanEvidenceById(source, id)),
        byId: (id: string) => read((source) => queries.findPlanById(source, id)),
        catalog: () => read(queries.readPlanResourceCatalog),
        resources: () => read(queries.listPlanResources),
        resolve: (reference: string) => read((source) => queries.resolvePlan(source, reference)),
        children: (parent: string) => read((source) => queries.findPlansByParent(source, parent)),
        archives: () => read(queries.listArchivedPlans),
        archived: (reference: string, byId = false) =>
            read((source) => queries.loadArchivedPlan(source, reference, byId)),
    };
}
