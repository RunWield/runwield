// Adapt the pinned external component at build time; never write into the submodule.
const componentPath = "/third_party/plannotator/packages/review-editor/components/AllFilesCodeView.tsx";
const replacements = [
    [
        "  expandedGeneratedFiles: Set<string> | undefined,\n): ItemIdentity",
        "  expandedGeneratedFiles: Set<string> | undefined,\n  rememberedCollapse: Map<string, boolean>,\n): ItemIdentity",
    ],
    [
        "const seedFileCollapsed = seedCollapsed\n      || (generatedFiles?.has(file.path) === true && expandedGeneratedFiles?.has(file.path) !== true);",
        "const seedFileCollapsed = rememberedCollapse.get(file.path) ?? (seedCollapsed\n      || (generatedFiles?.has(file.path) === true && expandedGeneratedFiles?.has(file.path) !== true));",
    ],
    [
        "  const identity = useMemo<ItemIdentity>(",
        "  const rememberedCollapse = useRef(new Map<string, boolean>());\n  const identity = useMemo<ItemIdentity>(",
    ],
    [
        "      expandedGeneratedRef.current,\n    ),",
        "      expandedGeneratedRef.current,\n      rememberedCollapse.current,\n    ),",
    ],
    [
        "useEffect(() => setAllCollapsed(seedCollapsed === true), [identity.items, seedCollapsed]);",
        "useEffect(() => setAllCollapsed(identity.items.every(item => item.collapsed === true)), [identity.items]);",
    ],
    [
        "    onFileCollapsedChange?.(filePath, collapsed);",
        "    rememberedCollapse.current.set(filePath, collapsed);\n    onFileCollapsedChange?.(filePath, collapsed);",
    ],
] as const;

/** Preserve file collapse choices across repaired patches in both review views. */
export function reviewCollapseStatePlugin() {
    return {
        name: "runwield-review-collapse-state",
        enforce: "pre" as const,
        transform(source: string, id: string) {
            if (!id.split("?")[0].endsWith(componentPath)) return null;
            let code = source;
            for (const [before, after] of replacements) {
                if (code.split(before).length !== 2) {
                    throw new Error("Plannotator collapse-state adaptation no longer matches the pinned component.");
                }
                code = code.replace(before, after);
            }
            return { code, map: null };
        },
    };
}
