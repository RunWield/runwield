export interface CommandResult {
    status: "passed" | "failed" | "cancelled";
    code: number | null;
    output: string;
}
