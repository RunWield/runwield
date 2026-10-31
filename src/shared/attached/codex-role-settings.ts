/** Codex preferences are dispatch hints, never Core model settings or workflow authority. */
import { join } from "node:path";
import { getCustomSetting, getSettingsDir } from "../settings.js";
import {
    ATTACHED_HOST_ROLES,
    type AttachedHostRole,
    type AttachedJsonObject,
    type AttachedJsonValue,
} from "./operations.ts";

interface CodexRolePreferences {
    model?: string;
    thinkingLevel?: string;
}
type CodexRoles = Partial<Record<AttachedHostRole, CodexRolePreferences>>;

export type CodexRoleDispatch = {
    host: "codex";
    role: AttachedHostRole;
} & ({ status: "ready"; model: string; thinkingLevel: string } | { status: "invalid"; diagnostics: string[] });

function readObject(value: AttachedJsonValue | undefined, path: string): AttachedJsonObject {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path}: expected an object.`);
    }
    return value;
}

function readRoles(value: AttachedJsonValue | undefined): CodexRoles {
    const connect = readObject(value, "connect");
    const codex = readObject(connect.codex, "connect.codex");
    for (const key of Object.keys(codex)) {
        if (key !== "roles") throw new Error(`connect.codex.${key}: unsupported field. Use roles.`);
    }
    const roles = readObject(codex.roles, "connect.codex.roles");
    const result: CodexRoles = {};
    for (const name of Object.keys(roles)) {
        if (!ATTACHED_HOST_ROLES.some((role) => role === name)) {
            throw new Error(`connect.codex.roles.${name}: unsupported role. Use ${ATTACHED_HOST_ROLES.join(", ")}.`);
        }
    }
    for (const role of ATTACHED_HOST_ROLES) {
        const fields = readObject(roles[role], `connect.codex.roles.${role}`);
        const preferences: CodexRolePreferences = {};
        for (const [field, value] of Object.entries(fields)) {
            const path = `connect.codex.roles.${role}.${field}`;
            if (field !== "model" && field !== "thinkingLevel") {
                throw new Error(`${path}: unsupported field. Use model or thinkingLevel.`);
            }
            if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
                throw new Error(
                    `${path}: use a nonempty Codex-native string without surrounding whitespace, or "inherit".`,
                );
            }
            preferences[field] = value;
        }
        result[role] = preferences;
    }
    return result;
}

/** Re-read both scopes for each dispatch. Explicit inheritance stops per-field lookup. */
export function resolveCodexRoleSettings(projectRoot: string, role: AttachedHostRole): CodexRoleDispatch {
    const scopes: Partial<Record<"global" | "project", CodexRoles>> = {};
    const diagnostics: string[] = [];
    for (const scope of ["global", "project"] as const) {
        try {
            scopes[scope] = readRoles(getCustomSetting("connect", scope, projectRoot, { strict: true }));
        } catch (error) {
            diagnostics.push(
                `${join(getSettingsDir(scope, projectRoot), "settings.json")}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    if (diagnostics.length) return { host: "codex", role, status: "invalid", diagnostics };
    return {
        host: "codex",
        role,
        status: "ready",
        model: scopes.project?.[role]?.model ?? scopes.global?.[role]?.model ?? "inherit",
        thinkingLevel: scopes.project?.[role]?.thinkingLevel ?? scopes.global?.[role]?.thinkingLevel ?? "inherit",
    };
}
