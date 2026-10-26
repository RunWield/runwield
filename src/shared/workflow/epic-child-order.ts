import type { PlanFrontMatter } from "../../plan-store.js";

interface OrderedChild {
    name: string;
    attrs: Pick<PlanFrontMatter, "order">;
}

/** Ambiguous order stays readable, but must never select an automatic next child by filename. */
export function epicChildOrderProblem(children: OrderedChild[]): string | undefined {
    const seen = new Map<number, string>();
    for (const child of children) {
        const order = child.attrs.order;
        if (order === undefined || !Number.isInteger(order) || order < 0) {
            return `Child ${child.name} needs an explicit non-negative integer order. Automatic next-child execution is blocked; individual Plans remain readable.`;
        }
        const previous = seen.get(order);
        if (previous) {
            return `Children ${previous} and ${child.name} have duplicate order ${order}. Automatic next-child execution is blocked; individual Plans remain readable.`;
        }
        seen.set(order, child.name);
    }
    return undefined;
}
