import { Store } from "./store.ts";
import { ValidationOwner } from "./validation.ts";
import type { State, Task } from "./model.ts";

export class TaskService {
    private store: Store;
    private validation: ValidationOwner;
    constructor(root: string) {
        this.store = new Store(root);
        this.validation = new ValidationOwner(this.store);
    }
    async addTask(id: string): Promise<void> {
        const state = await this.store.read();
        if (state.tasks.some((task) => task.id === id)) throw new Error("Task already exists");
        state.tasks.push({ id, kind: "general", completed: false });
        await this.store.write(state);
    }
    async requestRepair(taskId: string): Promise<void> {
        await this.validation.requestRepair(taskId);
    }
    async snapshot(): Promise<State> {
        return this.store.read();
    }
    async recordCompletion(taskId: string): Promise<Task> {
        const state = await this.store.read();
        const task = state.tasks.find((entry) => entry.id === taskId);
        if (!task) throw new Error("Task not found");
        task.completed = true;
        await this.store.write(state);
        return task;
    }
    async completeTask(taskId: string): Promise<void> {
        const task = await this.recordCompletion(taskId);
        await this.onCompletion(task);
    }
    private async onCompletion(task: Task): Promise<void> {
        if (task.kind === "repair") return;
        const state = await this.store.read();
        state.notifications.push(task.id);
        await this.store.write(state);
    }
}
