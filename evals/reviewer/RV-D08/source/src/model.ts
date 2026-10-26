export interface Task {
    id: string;
    kind: "general" | "repair";
    completed: boolean;
}
export interface Consumption {
    taskId: string;
    owner: "listener" | "validation";
}
export interface State {
    tasks: Task[];
    notifications: string[];
    phase: "idle" | "repairing" | "checking";
    repairTaskId?: string;
    consumers: Consumption[];
    transitions: string[];
}
export interface Completion {
    taskId: string;
}
