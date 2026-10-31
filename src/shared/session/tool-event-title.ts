/**
 * @module shared/session/tool-event-title
 * Build the semantic tool title carried by both live and replayed Runtime
 * events. Consumers receive the same tool name and argument summary regardless
 * of whether the event came from an active turn or persisted history.
 */

interface CodeBatchOperation {
    op: string;
    target?: string;
    file?: string;
}

interface ToolFileEdit {
    path?: string;
    file_path?: string;
}

export interface RuntimeToolTitleArgs {
    path?: string | string[];
    file_path?: string;
    AbsolutePath?: string;
    TargetFile?: string;
    edits?: ToolFileEdit[];
    operations?: CodeBatchOperation[];
    command?: string;
    CommandLine?: string;
    Action?: string;
    TaskId?: string;
    pattern?: string;
    query?: string;
    textSearch?: boolean;
    target?: string;
    file?: string;
    symbol?: string;
    library?: string;
    url?: string;
    planName?: string;
    action?: string;
    id?: string | number;
    content?: string;
    recordId?: string;
    summary?: string;
    supersededRequirement?: string;
    message?: string;
    name?: string;
    brief?: string;
    mode?: string;
}

export type RuntimeToolKind =
    "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export interface RuntimeToolDescriptor {
    toolName: string;
    title: string;
    kind: RuntimeToolKind;
}

function formatCodeBatchHeaderArgs(args: RuntimeToolTitleArgs | undefined | null): string {
    if (!args || !Array.isArray(args.operations)) return "0 operations";

    const operations = args.operations;
    if (operations.length === 0) return "0 operations";

    const summaries = operations.slice(0, 3).map((operation) => {
        if (operation.op === "show") return `show ${operation.target || ""}`.trim();
        if (operation.op === "outline") return `outline ${operation.file || ""}`.trim();
        return operation.op || "operation";
    });
    const remainingCount = operations.length - summaries.length;
    if (remainingCount > 0) summaries.push(`+${remainingCount} more`);
    return summaries.join("; ");
}

function getFilePathForTool(toolName: string, args: RuntimeToolTitleArgs | null | undefined): string | null {
    if (!args) return null;

    switch (toolName) {
        case "view_file":
            return typeof args.AbsolutePath === "string" ? args.AbsolutePath : null;
        case "write_to_file":
        case "replace_file_content":
            return typeof args.TargetFile === "string" ? args.TargetFile : null;
        case "read":
        case "edit":
        case "write":
        case "edit_docs":
        case "write_docs":
            return typeof args.path === "string"
                ? args.path
                : typeof args.file_path === "string"
                  ? args.file_path
                  : null;
        case "multi_file_edit": {
            if (!Array.isArray(args.edits) || args.edits.length === 0) return null;
            const paths = args.edits
                .map((edit) =>
                    typeof edit.path === "string"
                        ? edit.path
                        : typeof edit.file_path === "string"
                          ? edit.file_path
                          : null,
                )
                .filter(Boolean);
            const uniquePaths = [...new Set(paths)];
            if (uniquePaths.length === 0) return null;
            if (uniquePaths.length === 1) return uniquePaths[0];
            return `${uniquePaths[0]} +${uniquePaths.length - 1} files`;
        }
        default:
            return null;
    }
}

function formatToolEventTitle(toolName: string, args: RuntimeToolTitleArgs | null | undefined): string {
    const filePath = getFilePathForTool(toolName, args);
    let headerArgs: string | string[] = "";
    if (filePath) headerArgs = filePath;
    else if (toolName === "bash") headerArgs = args?.command || "";
    else if (toolName === "run_command") headerArgs = args?.CommandLine || "";
    else if (toolName === "manage_task") headerArgs = [args?.Action, args?.TaskId].filter(Boolean).join(" ");
    else if (toolName === "grep") {
        const path = Array.isArray(args?.path) ? args.path.join(" ") : args?.path || ".";
        headerArgs = `${args?.pattern} in ${path}`;
    } else if (toolName === "find") {
        headerArgs = `${args?.pattern} in ${args?.path || "."}`;
    } else if (toolName === "ls") {
        headerArgs = args?.path || ".";
    } else if (toolName === "code_search") {
        const query = args?.query || "";
        headerArgs = args?.textSearch ? `${query} (text)` : query;
    } else if (toolName === "code_show") {
        headerArgs = args?.target || "";
    } else if (toolName === "code_outline") {
        headerArgs = args?.file || "";
    } else if (toolName === "code_batch") {
        headerArgs = formatCodeBatchHeaderArgs(args);
    } else if (
        toolName === "code_refs" ||
        toolName === "code_impact" ||
        toolName === "code_trace" ||
        toolName === "code_investigate" ||
        toolName === "code_impls"
    ) {
        headerArgs = args?.symbol || "";
    } else if (toolName === "code_importers") {
        headerArgs = args?.target || "";
    } else if (toolName === "web_search" || toolName === "web_code_search") {
        headerArgs = args?.query || "";
    } else if (toolName === "web_docs_search") {
        headerArgs = [args?.library, args?.query].filter(Boolean).join(" ");
    } else if (toolName === "web_fetch") {
        headerArgs = args?.url || "";
    } else if (toolName === "code_structure" || toolName === "code_codebase_info") {
        headerArgs = "";
    } else if (toolName === "plan_written") {
        const planName = String(args?.planName || "")
            .replace(/\.md$/i, "")
            .trim();
        headerArgs = planName ? `docs/plans/${planName}.md` : "";
    } else if (toolName === "memory") {
        if (args?.action === "recall") {
            headerArgs = `- recall: ${args?.query || ""}`;
        } else if (args?.action === "delete") {
            headerArgs = `- delete: id: ${args?.id}`;
        } else if (args?.action === "store") {
            const content = args?.content || "";
            const preview = content.length > 80 ? content.slice(0, 77) + "..." : content;
            headerArgs = `- store: ${preview}`;
        }
    } else if (toolName === "memory_recall" || toolName === "memory_recall_global") {
        headerArgs = args?.query || "";
    } else if (toolName === "memory_write") {
        if (args?.action === "delete") {
            headerArgs = `id: ${args?.id}`;
        } else {
            const content = args?.content || "";
            headerArgs = content.length > 80 ? content.slice(0, 77) + "..." : content;
        }
    } else if (toolName === "memory_store" || toolName === "memory_store_global") {
        const content = args?.content || "";
        headerArgs = content.length > 80 ? content.slice(0, 77) + "..." : content;
    } else if (toolName === "memory_delete") {
        headerArgs = `id: ${args?.id}`;
    } else if (toolName === "work_record_search") {
        headerArgs = args?.query || "";
    } else if (toolName === "work_record_read") {
        headerArgs = args?.recordId || "";
    } else if (toolName === "pair_checkpoint") {
        const summary = String(args?.summary || "").trim();
        headerArgs = summary.length > 60 ? summary.slice(0, 57) + "..." : summary;
    } else if (toolName === "record_plan_deviation") {
        const requirement = String(args?.supersededRequirement || "").trim();
        headerArgs = requirement.length > 60 ? requirement.slice(0, 57) + "..." : requirement;
    } else if (toolName === "task_completed") {
        const message = args?.message || "";
        headerArgs = message.length > 60 ? message.slice(0, 57) + "..." : message;
    } else if (toolName === "set_session_name") {
        headerArgs = args?.name || "";
    } else if (toolName === "delegate_agent") {
        const brief = String(args?.brief || "").trim();
        const preview = brief.length > 60 ? brief.slice(0, 57) + "..." : brief;
        headerArgs = `${args?.mode || "read"}${preview ? `: ${preview}` : ""}`;
    }

    return toolName === "bash" ? `$ ${headerArgs}`.trim() : `${toolName} ${headerArgs}`.trim();
}

/**
 * Build the complete stable identity consumers use to present a tool call.
 */
export function describeRuntimeTool<Args extends RuntimeToolTitleArgs>(
    toolName: string,
    args: Args | null | undefined,
): RuntimeToolDescriptor {
    let kind: RuntimeToolKind = "other";
    if (toolName === "read" || toolName === "ls" || toolName === "view_file") kind = "read";
    else if (
        toolName === "edit" ||
        toolName === "write" ||
        toolName === "write_to_file" ||
        toolName === "replace_file_content" ||
        toolName === "multi_file_edit" ||
        toolName === "edit_docs" ||
        toolName === "write_docs"
    )
        kind = "edit";
    else if (
        toolName === "grep" ||
        toolName === "find" ||
        toolName === "code_search" ||
        toolName === "code_refs" ||
        toolName === "code_impact" ||
        toolName === "code_trace" ||
        toolName === "code_impls" ||
        toolName === "code_importers" ||
        toolName === "code_structure" ||
        toolName === "code_codebase_info" ||
        toolName === "memory_recall" ||
        toolName === "memory_recall_global" ||
        toolName === "work_record_search" ||
        toolName === "web_search" ||
        toolName === "web_code_search" ||
        toolName === "web_docs_search"
    )
        kind = "search";
    else if (toolName === "memory") {
        if (args?.action === "recall") kind = "search";
        else kind = args?.action === "delete" ? "delete" : "edit";
    } else if (toolName === "memory_write") kind = args?.action === "delete" ? "delete" : "edit";
    else if (toolName === "work_record_read") kind = "read";
    else if (toolName === "bash" || toolName === "run_command") kind = "execute";
    else if (toolName === "web_fetch") kind = "fetch";
    else if (toolName === "code_investigate" || toolName === "delegate_agent") kind = "think";
    return { toolName, title: formatToolEventTitle(toolName, args), kind };
}
