import type { APIContext } from "astro";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
export interface TestEnvironmentValues {
    [key: string]: string | undefined;
}

type StringValues = Record<string, string>;

export function createTestEnv(values: TestEnvironmentValues) {
    return {
        get(key: string) {
            return values[key];
        },
        set(key: string, value: string) {
            values[key] = value;
        },
        delete(key: string) {
            delete values[key];
        },
        has(key: string) {
            return values[key] !== undefined;
        },
        toObject() {
            const result: StringValues = {};
            for (const [key, value] of Object.entries(values)) {
                if (value !== undefined) result[key] = value;
            }
            return result;
        },
    };
}

export function createTestApiContext(request: Request): APIContext {
    return { request } as APIContext;
}

export async function git(cwd: string, args: string[]) {
    const output = await captureForegroundProcess("git", { cwd, args });
    if (!output.success) {
        const decoder = new TextDecoder();
        throw new Error(decoder.decode(output.stderr) || decoder.decode(output.stdout));
    }
    return new TextDecoder().decode(output.stdout);
}

export async function readJsonResponse(response: Response) {
    return await response.json();
}

export function jsonRequest<Body>(url: string, body: Body, bearer?: string) {
    const headers: StringValues = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}
