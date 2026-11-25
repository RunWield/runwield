import {
    extractYaml,
    test as hasFrontMatter,
    type FrontMatterRecord,
    type FrontMatterValue,
} from "@runwield/parsing/front-matter";
import { toolRegistry, type WorkKind } from "@runwield/tools";
import { normalizeTicketReferences, type TicketReference } from "../format/ticket-references.ts";

const { normalizeWorkKind } = toolRegistry.get("triage_report");

const WORK_RECORD_KIND = "work_record";

const WORK_RECORD_STATUSES = Object.freeze(["pending_verification", "draft", "approved", "superseded"]);

const WORK_RECORD_SCOPES = Object.freeze(["planned_change", "feature", "epic", "quick_fix"]);
const WORK_RECORD_ORIGINS = Object.freeze(["internal", "external"]);
const WORK_RECORD_COMPLETION_MODES = Object.freeze([
    "verified",
    "closed_without_verification",
    "user_verified",
    "done_enough",
]);

const WORK_RECORD_OPTIONAL_SECTION_TITLES = Object.freeze([
    "Deviations from Plan",
    "Out of Scope",
    "Deferred Work",
    "Future Planning Notes",
    "Required Record Notes",
]);

const WORK_RECORD_FRONT_MATTER_KEYS = Object.freeze({
    kind: "kind",
    recordId: "recordId",
    status: "status",
    scope: "scope",
    workKind: "workKind",
    origin: "origin",
    completionMode: "completionMode",
    createdAt: "createdAt",
    tickets: "tickets",
    archivedAt: "archivedAt",
    supersedes: "supersedes",
    supersededBy: "supersededBy",
    supersessionProposal: "supersessionProposal",
    provenance: "provenance",
});

type WorkRecordStatus = "pending_verification" | "draft" | "approved" | "superseded";
export type WorkRecordScope = "planned_change" | "feature" | "epic" | "quick_fix";
type WorkRecordOrigin = "internal" | "external";
export type WorkRecordCompletionMode = "verified" | "closed_without_verification" | "user_verified" | "done_enough";

type WorkRecordEvidence = {
    path: string;
    note: string;
};

type WorkRecordProvenance = {
    sourcePlans?: string[];
    evidence?: WorkRecordEvidence[];
};

export type WorkRecordSupersessionCandidate = {
    recordId: string;
    reason: string;
};

type WorkRecordSupersessionProposal = {
    candidates: WorkRecordSupersessionCandidate[];
};

export type WorkRecordFrontMatter = {
    kind: typeof WORK_RECORD_KIND;
    recordId: string;
    status: WorkRecordStatus;
    scope: WorkRecordScope;
    workKind?: WorkKind;
    origin: WorkRecordOrigin;
    completionMode: WorkRecordCompletionMode;
    createdAt: string;
    tickets?: TicketReference[];
    archivedAt?: string;
    supersedes?: string | string[];
    supersededBy?: string;
    supersessionProposal?: WorkRecordSupersessionProposal;
    provenance?: WorkRecordProvenance;
};

type UnvalidatedWorkRecordFrontMatter = Omit<
    WorkRecordFrontMatter,
    "kind" | "status" | "scope" | "origin" | "completionMode"
> & {
    kind: FrontMatterValue | undefined;
    status: string;
    scope: string;
    origin: string;
    completionMode: string;
};

interface WorkRecordSections {
    title: string;
    summary: string;
    optional: Record<string, string>;
}

export interface GeneratedWorkRecordSections extends Pick<WorkRecordSections, "title" | "summary"> {
    outOfScope?: string;
    futurePlanningNotes?: string;
    supersessionProposals?: WorkRecordSupersessionCandidate[];
}

export interface WorkRecordResource {
    attrs: WorkRecordFrontMatter;
    body: string;
    markdown: string;
    title: string;
    summary: string;
    sections: Record<string, string>;
    path: string;
    relativePath: string;
}

type ParseWorkRecordOptions = Partial<Pick<WorkRecordResource, "path" | "relativePath">>;

function isFrontMatterList(value: FrontMatterValue | undefined): value is readonly FrontMatterValue[] {
    return Array.isArray(value);
}

function isFrontMatterRecord(value: FrontMatterValue | undefined): value is FrontMatterRecord {
    return value !== null && typeof value === "object" && !isFrontMatterList(value) && !(value instanceof Date);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asTrimmedString(value: FrontMatterValue | undefined): string {
    if (typeof value === "string") return value.trim();
    if (value instanceof Date) return value.toISOString();
    return "";
}

function stringList(value: FrontMatterValue | undefined): string[] | undefined {
    if (!isFrontMatterList(value)) return undefined;
    const list = value.map(asTrimmedString).filter(Boolean);
    return list.length ? list : undefined;
}

function evidenceList(value: FrontMatterValue | undefined): WorkRecordEvidence[] | undefined {
    if (!isFrontMatterList(value) || !value.length) return undefined;
    return value.map((item) => {
        if (!isFrontMatterRecord(item)) return { path: "", note: "" };
        return {
            path: asTrimmedString(item.path),
            note: asTrimmedString(item.note),
        };
    });
}

function normalizeWorkRecordProvenance(value: FrontMatterValue | undefined): WorkRecordProvenance | undefined {
    if (!isFrontMatterRecord(value)) return undefined;
    const sourcePlans = stringList(value.sourcePlans);
    const evidence = evidenceList(value.evidence);
    if (!sourcePlans && !evidence) return undefined;
    return {
        ...(sourcePlans ? { sourcePlans } : {}),
        ...(evidence ? { evidence } : {}),
    };
}

function normalizeSupersessionProposal(
    value: FrontMatterValue | undefined,
    supersedes: Set<string>,
): WorkRecordSupersessionProposal | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isFrontMatterRecord(value) && !(value instanceof Date)) {
        throw new Error("Invalid Work Record: supersessionProposal must be an object.");
    }
    const proposalKeys = Object.keys(value);
    if (proposalKeys.some((key) => key !== "candidates")) {
        throw new Error("Invalid Work Record: supersessionProposal contains unknown keys.");
    }
    const rawCandidates = value instanceof Date ? undefined : value.candidates;
    if (!isFrontMatterList(rawCandidates)) {
        throw new Error("Invalid Work Record: supersessionProposal.candidates must be an array.");
    }
    const seen = new Set<string>();
    const candidates: WorkRecordSupersessionCandidate[] = [];
    for (const candidate of rawCandidates) {
        if (!isFrontMatterRecord(candidate) && !(candidate instanceof Date)) {
            throw new Error("Invalid Work Record: each supersessionProposal candidate must be an object.");
        }
        if (Object.keys(candidate).some((key) => key !== "recordId" && key !== "reason")) {
            throw new Error("Invalid Work Record: supersessionProposal candidate contains unknown keys.");
        }
        const recordId = asTrimmedString(candidate instanceof Date ? undefined : candidate.recordId);
        if (!UUID_RE.test(recordId)) {
            throw new Error(
                "Invalid Work Record: supersessionProposal candidate recordId must be a plain UUID string.",
            );
        }
        const reason = asTrimmedString(candidate instanceof Date ? undefined : candidate.reason);
        if (!reason) {
            throw new Error("Invalid Work Record: supersessionProposal candidate reason must be a non-blank string.");
        }
        const identity = recordId.toLowerCase();
        if (supersedes.has(identity)) {
            throw new Error("Invalid Work Record: supersessionProposal candidate already appears in supersedes.");
        }
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({ recordId, reason });
    }
    return candidates.length ? { candidates } : undefined;
}

function normalizeWorkRecordFrontMatter(attrs: FrontMatterRecord): UnvalidatedWorkRecordFrontMatter {
    const provenance = normalizeWorkRecordProvenance(attrs.provenance);
    const normalizedSupersedes = isFrontMatterList(attrs.supersedes)
        ? stringList(attrs.supersedes) || []
        : asTrimmedString(attrs.supersedes) || undefined;
    const supersedesIdentities = new Set(
        (Array.isArray(normalizedSupersedes)
            ? normalizedSupersedes
            : normalizedSupersedes
              ? [normalizedSupersedes]
              : []
        ).map((recordId) => recordId.toLowerCase()),
    );
    const supersessionProposal = normalizeSupersessionProposal(attrs.supersessionProposal, supersedesIdentities);
    const rawWorkKind = typeof attrs.workKind === "string" ? normalizeWorkKind(attrs.workKind) : undefined;
    const rawScope = asTrimmedString(attrs.scope);
    const normalizedScope = rawScope === "feature" ? "planned_change" : rawScope;
    const tickets = normalizeTicketReferences(attrs.tickets);
    const archivedAt = asTrimmedString(attrs.archivedAt);
    const supersededBy = asTrimmedString(attrs.supersededBy);
    return {
        kind: attrs.kind,
        recordId: asTrimmedString(attrs.recordId),
        status: asTrimmedString(attrs.status),
        scope: normalizedScope,
        ...(rawWorkKind ? { workKind: rawWorkKind } : {}),
        origin: asTrimmedString(attrs.origin),
        completionMode: asTrimmedString(attrs.completionMode),
        createdAt: asTrimmedString(attrs.createdAt),
        ...(tickets ? { tickets } : {}),
        ...(archivedAt ? { archivedAt } : {}),
        ...(normalizedSupersedes ? { supersedes: normalizedSupersedes } : {}),
        ...(supersededBy ? { supersededBy } : {}),
        ...(supersessionProposal ? { supersessionProposal } : {}),
        ...(provenance ? { provenance } : {}),
    };
}

function yamlScalar(value: string) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appendScalarOrList(lines: string[], key: string, value: FrontMatterValue | undefined) {
    if (value === undefined || value === null) return;
    if (isFrontMatterList(value)) {
        if (!value.length) return;
        lines.push(`${key}:`);
        for (const item of value) lines.push(`    - ${yamlScalar(String(item))}`);
        return;
    }
    if (String(value).trim()) lines.push(`${key}: ${yamlScalar(String(value))}`);
}

function appendYamlValue(lines: string[], key: string, value: FrontMatterValue | undefined, indent: number) {
    const pad = " ".repeat(indent);
    if (isFrontMatterList(value)) {
        if (!value.length) return;
        lines.push(`${pad}${key}:`);
        for (const item of value) appendYamlObjectListItem(lines, item, indent + 4);
        return;
    }
    if (isFrontMatterRecord(value)) {
        const entries = Object.entries(value).filter(([, child]) => child !== undefined);
        if (!entries.length) return;
        lines.push(`${pad}${key}:`);
        for (const [childKey, childValue] of entries) appendYamlValue(lines, childKey, childValue, indent + 4);
        return;
    }
    if (typeof value === "string") lines.push(`${pad}${key}: ${yamlScalar(value)}`);
    else if (value === null) lines.push(`${pad}${key}: null`);
    else lines.push(`${pad}${key}: ${String(value)}`);
}

function appendYamlObjectListItem(lines: string[], value: FrontMatterValue | undefined, indent: number) {
    const pad = " ".repeat(indent);
    if (isFrontMatterRecord(value)) {
        const entries = Object.entries(value).filter(([, child]) => child !== undefined);
        if (!entries.length) return;
        const [firstKey, firstValue] = entries[0];
        if (typeof firstValue === "string") lines.push(`${pad}- ${firstKey}: ${yamlScalar(firstValue)}`);
        else if (firstValue === null) lines.push(`${pad}- ${firstKey}: null`);
        else if (["number", "boolean"].includes(typeof firstValue)) {
            lines.push(`${pad}- ${firstKey}: ${String(firstValue)}`);
        } else {
            lines.push(`${pad}- ${firstKey}:`);
            appendYamlObjectListItem(lines, firstValue, indent + 4);
        }
        for (const [childKey, childValue] of entries.slice(1)) appendYamlValue(lines, childKey, childValue, indent + 2);
        return;
    }
    if (typeof value === "string") lines.push(`${pad}- ${yamlScalar(value)}`);
    else if (value === null) lines.push(`${pad}- null`);
    else lines.push(`${pad}- ${String(value)}`);
}

function appendProvenance(lines: string[], provenance: WorkRecordProvenance | undefined) {
    if (!provenance) return;
    const hasSourcePlans = Array.isArray(provenance.sourcePlans) && provenance.sourcePlans.length > 0;
    const hasEvidence = Array.isArray(provenance.evidence) && provenance.evidence.length > 0;
    if (!hasSourcePlans && !hasEvidence) return;
    lines.push(`${WORK_RECORD_FRONT_MATTER_KEYS.provenance}:`);
    if (hasSourcePlans) {
        lines.push("    sourcePlans:");
        for (const planId of provenance.sourcePlans || []) lines.push(`        - ${yamlScalar(planId)}`);
    }
    if (hasEvidence) {
        lines.push("    evidence:");
        for (const entry of provenance.evidence || []) {
            lines.push(`        - path: ${yamlScalar(entry.path)}`);
            lines.push(`          note: ${yamlScalar(entry.note)}`);
        }
    }
}

function formatWorkRecordFrontMatter(attrs: WorkRecordFrontMatter) {
    const fm = normalizeWorkRecordFrontMatter(attrs);
    const lines = ["---"];
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.kind, fm.kind);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.recordId, fm.recordId);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.status, fm.status);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.scope, fm.scope);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.workKind, fm.workKind);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.origin, fm.origin);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.completionMode, fm.completionMode);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.createdAt, fm.createdAt);
    if (fm.tickets) appendYamlValue(lines, WORK_RECORD_FRONT_MATTER_KEYS.tickets, fm.tickets, 0);
    appendProvenance(lines, fm.provenance);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.archivedAt, fm.archivedAt);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.supersedes, fm.supersedes);
    appendScalarOrList(lines, WORK_RECORD_FRONT_MATTER_KEYS.supersededBy, fm.supersededBy);
    if (fm.supersessionProposal) {
        appendYamlValue(lines, WORK_RECORD_FRONT_MATTER_KEYS.supersessionProposal, fm.supersessionProposal, 0);
    }
    lines.push("---");
    return lines.join("\n");
}

function formatWorkRecordMarkdown(attrs: WorkRecordFrontMatter, body: string) {
    return `${formatWorkRecordFrontMatter(attrs)}\n${String(body || "").replace(/^\s*/, "")}`;
}

function extractWorkRecordSections(body: string): WorkRecordSections {
    const text = String(body || "").replace(/^\s+/, "");
    const titleMatch = text.match(/^#\s+(.+)\s*$/m);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const headingMatches = [...text.matchAll(/^##\s+(.+)\s*$/gm)];
    const sections: WorkRecordSections["optional"] = {};
    for (let i = 0; i < headingMatches.length; i += 1) {
        const match = headingMatches[i];
        const name = match[1].trim();
        const start = (match.index || 0) + match[0].length;
        const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index || text.length : text.length;
        sections[name] = text.slice(start, end).trim();
    }
    const optional: WorkRecordSections["optional"] = {};
    for (const title of WORK_RECORD_OPTIONAL_SECTION_TITLES) {
        if (sections[title]) optional[title] = sections[title];
    }
    // Older records used Result for the same prose. Read them without rewriting
    // their history; generated records continue to use the canonical Summary.
    return { title, summary: sections.Summary || sections.Result || "", optional };
}

function validateWorkRecord(
    attrs: UnvalidatedWorkRecordFrontMatter,
    sections: WorkRecordSections,
): asserts attrs is WorkRecordFrontMatter {
    const errors = [];
    if (attrs.kind !== WORK_RECORD_KIND) errors.push('kind must be "work_record".');
    if (!UUID_RE.test(attrs.recordId || "")) errors.push("recordId must be a plain UUID string.");
    if (!WORK_RECORD_STATUSES.includes(attrs.status)) errors.push(`status is invalid: ${attrs.status || "missing"}.`);
    if (!WORK_RECORD_SCOPES.includes(attrs.scope)) errors.push(`scope is invalid: ${attrs.scope || "missing"}.`);
    if (!WORK_RECORD_ORIGINS.includes(attrs.origin)) errors.push(`origin is invalid: ${attrs.origin || "missing"}.`);
    if (!WORK_RECORD_COMPLETION_MODES.includes(attrs.completionMode)) {
        errors.push(`completionMode is invalid: ${attrs.completionMode || "missing"}.`);
    }
    if (!attrs.createdAt) errors.push("createdAt is required.");
    if (attrs.origin === "internal" && !attrs.provenance?.sourcePlans?.length) {
        errors.push("provenance.sourcePlans is required for internal Work Records.");
    }
    if (attrs.provenance?.evidence) {
        for (const entry of attrs.provenance.evidence) {
            if (!entry.path || !entry.note) errors.push("provenance.evidence entries require path and note.");
        }
    }
    if (!sections.title) errors.push("Markdown body must start with an H1 title.");
    if (!sections.summary) errors.push("Markdown body must include a non-empty ## Summary section.");
    if (errors.length) throw new Error(`Invalid Work Record: ${errors.join(" ")}`);
}

function parseWorkRecordMarkdown(markdown: string, options: ParseWorkRecordOptions = {}): WorkRecordResource {
    if (!hasFrontMatter(markdown)) throw new Error("Invalid Work Record: front matter is required.");
    const { attrs, body } = extractYaml(markdown);
    const normalized = normalizeWorkRecordFrontMatter(attrs);
    const sections = extractWorkRecordSections(body);
    validateWorkRecord(normalized, sections);
    return {
        attrs: normalized,
        body,
        markdown,
        title: sections.title,
        summary: sections.summary,
        sections: sections.optional,
        path: options.path || "",
        relativePath: options.relativePath || "",
    };
}

export const documents = {
    parse: parseWorkRecordMarkdown,
    format: formatWorkRecordMarkdown,
} as const;
