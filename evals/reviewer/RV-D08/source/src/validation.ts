import { Store } from "./store.ts";
import type { Completion } from "./model.ts";

export class ValidationOwner {
    constructor(private store: Store) {}
    async requestRepair(taskId: string): Promise<void> {
        const state = await this.store.read();
        if (state.tasks.some((task) => task.id === taskId)) throw new Error("Task already exists");
        state.tasks.push({ id: taskId, kind: "repair", completed: false });
        state.repairTaskId = taskId;
        state.phase = "repairing";
        await this.store.write(state);
    }
    async consume(event: Completion, owner: "listener" | "validation"): Promise<void> {
        const state = await this.store.read();
        if (state.repairTaskId !== event.taskId) throw new Error("Wrong repair task");
        state.consumers.push({ taskId: event.taskId, owner });
        state.transitions.push("repairing->checking");
        state.phase = "checking";
        await this.store.write(state);
    }
}
