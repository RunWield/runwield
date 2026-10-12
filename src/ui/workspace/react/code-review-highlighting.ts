import { useEffect, useMemo, useState } from "react";
import {
    EXTENSION_TO_FILE_FORMAT,
    getCustomExtensionsMap,
    getFiletypeFromFileName,
    hasResolvedLanguages,
    resolveLanguage,
    setCustomExtension,
} from "@pierre/diffs";
import type { SupportedLanguages } from "@pierre/diffs";

const HIGHLIGHTING_READY_TIMEOUT_MS = 3000;

type ResolvableLanguage = Exclude<SupportedLanguages, "text" | "ansi">;

export type CodeReviewHighlightFile = {
    path: string;
};

export type CodeReviewLanguageEntry = {
    path: string;
    lookupKey: string;
    language: ResolvableLanguage;
};

export type CodeReviewHighlightingFallback = {
    path: string;
    lookupKey: string;
    language: ResolvableLanguage;
};

export type CodeReviewHighlightingResult = {
    languages: ResolvableLanguage[];
    fallbacks: CodeReviewHighlightingFallback[];
};

export function codeReviewLanguagesFor(paths: readonly string[]): ResolvableLanguage[] {
    const languages = new Set<ResolvableLanguage>();
    for (const path of paths) {
        const language = getFiletypeFromFileName(path);
        if (isResolvableLanguage(language)) languages.add(language);
    }
    return [...languages];
}

export async function prepareCodeReviewHighlighting(
    paths: readonly string[],
): Promise<CodeReviewHighlightingResult> {
    const entries = codeReviewLanguageEntriesFor(paths);
    const languages = [...new Set(entries.map((entry) => entry.language))];
    const fallbacks: CodeReviewHighlightingFallback[] = [];

    await Promise.all(languages.map(async (language) => {
        try {
            if (!hasResolvedLanguages(language)) await resolveLanguage(language);
        } catch {
            for (const entry of entries.filter((candidate) => candidate.language === language)) {
                setCustomExtension(entry.lookupKey, "text");
                fallbacks.push({
                    path: entry.path,
                    lookupKey: entry.lookupKey,
                    language,
                });
            }
            console.warn(
                `[RunWield] Code review syntax highlighting fell back to plain text for ${language}.`,
            );
        }
    }));

    return { languages, fallbacks };
}

export function useCodeReviewHighlighting(files: readonly CodeReviewHighlightFile[]): boolean {
    const paths = useMemo(() => files.map((file) => file.path), [files]);
    const preparationKey = useMemo(() => paths.join("\n"), [paths]);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let canceled = false;
        setReady(false);
        const timer = globalThis.setTimeout(() => {
            if (!canceled) setReady(true);
        }, HIGHLIGHTING_READY_TIMEOUT_MS);

        prepareCodeReviewHighlighting(paths).then(() => {
            if (!canceled) setReady(true);
        }).finally(() => {
            globalThis.clearTimeout(timer);
        });

        return () => {
            canceled = true;
            globalThis.clearTimeout(timer);
        };
    }, [preparationKey]);

    return ready;
}

function codeReviewLanguageEntriesFor(paths: readonly string[]): CodeReviewLanguageEntry[] {
    const entries: CodeReviewLanguageEntry[] = [];
    for (const path of paths) {
        const language = getFiletypeFromFileName(path);
        if (!isResolvableLanguage(language)) continue;
        entries.push({ path, lookupKey: lookupKeyForPath(path), language });
    }
    return entries;
}

function lookupKeyForPath(path: string): string {
    if (customOrBuiltInExtensionExists(path)) return path;

    const compoundMatch = path.match(/\.([^/\\]+\.[^/\\]+)$/);
    if (compoundMatch !== null && customOrBuiltInExtensionExists(compoundMatch[1])) return compoundMatch[1];

    const simpleMatch = path.match(/\.([^.]+)$/);
    return simpleMatch?.[1] ?? path;
}

function customOrBuiltInExtensionExists(key: string): boolean {
    const customExtensions = getCustomExtensionsMap();
    return customExtensions[key] !== undefined || EXTENSION_TO_FILE_FORMAT[key] !== undefined;
}

function isResolvableLanguage(language: SupportedLanguages): language is ResolvableLanguage {
    return language !== "text" && language !== "ansi";
}
