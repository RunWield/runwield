import { useEffect, useRef, useState } from "react";
import { createMoveStatusIntent, dispatchPlanLifecycleAction } from "./PlanLifecycleActions.tsx";

export interface DragPlanState {
    planId: string;
    planName: string;
    fromStatus: string;
    allowedTargetStatuses: Set<string>;
    card: HTMLElement;
}

export interface AllowedDropTargetOptions extends Pick<DragPlanState, "fromStatus" | "allowedTargetStatuses"> {
    targetStatus: string;
}

export interface BlockedDropMessageOptions extends Pick<DragPlanState, "planName" | "allowedTargetStatuses"> {
    targetStatus?: string;
}

export interface PlanBoardDragDropProps {
    boardId: string;
}

export function parseAllowedTargetStatuses(value: string) {
    return new Set(
        value
            .split(/\s+/)
            .map((status) => status.trim())
            .filter(Boolean),
    );
}

export function isAllowedDropTarget({ fromStatus, targetStatus, allowedTargetStatuses }: AllowedDropTargetOptions) {
    return Boolean(targetStatus) && targetStatus !== fromStatus && allowedTargetStatuses.has(targetStatus);
}

function allowedStatusList(statuses: Set<string>) {
    return [...statuses].join(", ") || "no columns";
}

export function blockedDropMessage({
    planName,
    targetStatus = "that column",
    allowedTargetStatuses,
}: BlockedDropMessageOptions) {
    return `${planName} cannot move to ${targetStatus}. Available columns: ${allowedStatusList(
        allowedTargetStatuses,
    )}.`;
}

function closestCard(element: Element | null) {
    return element?.closest?.<HTMLElement>('[data-draggable-plan-card="true"]') || null;
}

function closestColumn(element: Element | null) {
    return element?.closest?.<HTMLElement>("[data-action-target-status]") || null;
}

function clearDropClasses(boardElement: HTMLElement) {
    boardElement.querySelectorAll(".drop-allowed, .drop-blocked, .drop-target-active").forEach((element) => {
        element.classList.remove("drop-allowed", "drop-blocked", "drop-target-active");
    });
}

function makeDragImage(card: HTMLElement) {
    const clone = card.cloneNode(true) as HTMLElement;
    clone.classList.add("drag-image-card");
    clone.style.position = "fixed";
    clone.style.top = "-1000px";
    clone.style.left = "-1000px";
    clone.style.width = `${card.getBoundingClientRect().width}px`;
    document.body.appendChild(clone);
    return clone;
}

export function PlanBoardDragDrop({ boardId }: PlanBoardDragDropProps) {
    const [message, setMessage] = useState("");
    const dragging = useRef<DragPlanState | null>(null);

    useEffect(() => {
        const board = document.getElementById(boardId);
        if (!board) return undefined;
        const boardElement = board;

        function handleDragStart(event: DragEvent) {
            const card = closestCard(event.target as Element | null);
            if (!card || !event.dataTransfer) return;
            const allowedTargetStatuses = parseAllowedTargetStatuses(card.dataset.allowedTargetStatuses || "");
            const planId = card.dataset.planId || "";
            const planName = card.dataset.planName || planId;
            const fromStatus = card.dataset.status || "";
            if (!planId || !fromStatus || !allowedTargetStatuses.size) {
                event.preventDefault();
                setMessage(`${planName} cannot be dragged between columns. Available columns: no columns.`);
                return;
            }
            dragging.current = { planId, planName, fromStatus, allowedTargetStatuses, card };
            boardElement.classList.add("is-dragging-plan");
            card.classList.add("is-drag-source");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", planId);
            const dragImage = makeDragImage(card);
            const rect = card.getBoundingClientRect();
            const dragImageOffsetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
            const dragImageOffsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
            event.dataTransfer.setDragImage(dragImage, dragImageOffsetX, dragImageOffsetY);
            setTimeout(() => dragImage.remove(), 0);
            setMessage(`Moving ${planName}. Available columns: ${allowedStatusList(allowedTargetStatuses)}.`);
        }

        function handleDragOver(event: DragEvent) {
            const state = dragging.current;
            if (!state || !event.dataTransfer) return;
            const column = closestColumn(event.target as Element | null);
            if (!column) return;
            const targetStatus = column.dataset.actionTargetStatus || "";
            const allowed = isAllowedDropTarget({
                fromStatus: state.fromStatus,
                targetStatus,
                allowedTargetStatuses: state.allowedTargetStatuses,
            });
            clearDropClasses(boardElement);
            if (allowed) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                column.classList.add("drop-allowed", "drop-target-active");
                return;
            }
            event.dataTransfer.dropEffect = "none";
            column.classList.add("drop-blocked", "drop-target-active");
            setMessage(
                blockedDropMessage({
                    planName: state.planName,
                    targetStatus: targetStatus || "that column",
                    allowedTargetStatuses: state.allowedTargetStatuses,
                }),
            );
        }

        function handleDragLeave(event: DragEvent) {
            const state = dragging.current;
            if (!state) return;
            const column = closestColumn(event.target as Element | null);
            if (!column) return;
            const relatedTarget = (event.relatedTarget || null) as Node | null;
            if (relatedTarget && column.contains(relatedTarget)) return;
            column.classList.remove("drop-allowed", "drop-blocked", "drop-target-active");
        }

        function handleDrop(event: DragEvent) {
            const state = dragging.current;
            if (!state) return;
            const column = closestColumn(event.target as Element | null);
            const targetStatus = column?.dataset.actionTargetStatus || "";
            const allowed = isAllowedDropTarget({
                fromStatus: state.fromStatus,
                targetStatus,
                allowedTargetStatuses: state.allowedTargetStatuses,
            });
            event.preventDefault();
            if (!allowed) {
                state.card.classList.add("drop-rejected");
                setTimeout(() => state.card.classList.remove("drop-rejected"), 420);
                setMessage(
                    blockedDropMessage({
                        planName: state.planName,
                        targetStatus: targetStatus || "that column",
                        allowedTargetStatuses: state.allowedTargetStatuses,
                    }),
                );
                clearDropClasses(boardElement);
                return;
            }
            submitDrop(state, targetStatus);
        }

        function handleDragEnd(event: DragEvent) {
            const state = dragging.current;
            if (state && event.dataTransfer?.dropEffect === "none") {
                state.card.classList.add("drop-rejected");
                setTimeout(() => state.card.classList.remove("drop-rejected"), 420);
                setMessage(
                    blockedDropMessage({
                        planName: state.planName,
                        allowedTargetStatuses: state.allowedTargetStatuses,
                    }),
                );
            }
            dragging.current = null;
            boardElement.classList.remove("is-dragging-plan");
            boardElement
                .querySelectorAll(".is-drag-source")
                .forEach((element) => element.classList.remove("is-drag-source"));
            clearDropClasses(boardElement);
            boardElement.dataset.justDragged = "true";
            setTimeout(() => delete boardElement.dataset.justDragged, 0);
        }

        function handleClick(event: MouseEvent) {
            if (boardElement.dataset.justDragged === "true") {
                event.preventDefault();
                event.stopPropagation();
            }
        }

        async function submitDrop(state: DragPlanState, targetStatus: string) {
            clearDropClasses(boardElement);
            boardElement.classList.add("is-drop-pending");
            setMessage(`Moving ${state.planName} to ${targetStatus}…`);
            try {
                const { response, payload } = await dispatchPlanLifecycleAction(
                    createMoveStatusIntent({
                        planId: state.planId,
                        fromStatus: state.fromStatus,
                        toStatus: targetStatus,
                    }),
                );
                if (!response.ok) {
                    state.card.classList.add("drop-rejected");
                    setTimeout(() => state.card.classList.remove("drop-rejected"), 420);
                    setMessage(payload.blockedReason || payload.error || "Lifecycle move was blocked.");
                    return;
                }
                setMessage(payload.message || "Lifecycle move applied.");
                location.reload();
            } finally {
                boardElement.classList.remove("is-drop-pending");
            }
        }

        boardElement.addEventListener("dragstart", handleDragStart);
        boardElement.addEventListener("dragover", handleDragOver);
        boardElement.addEventListener("dragenter", handleDragOver);
        boardElement.addEventListener("dragleave", handleDragLeave);
        boardElement.addEventListener("drop", handleDrop);
        boardElement.addEventListener("dragend", handleDragEnd);
        boardElement.addEventListener("click", handleClick, true);
        return () => {
            boardElement.removeEventListener("dragstart", handleDragStart);
            boardElement.removeEventListener("dragover", handleDragOver);
            boardElement.removeEventListener("dragenter", handleDragOver);
            boardElement.removeEventListener("dragleave", handleDragLeave);
            boardElement.removeEventListener("drop", handleDrop);
            boardElement.removeEventListener("dragend", handleDragEnd);
            boardElement.removeEventListener("click", handleClick, true);
        };
    }, [boardId]);

    return (
        <p className="notice muted board-dnd-status" aria-live="polite" data-board-dnd-status hidden={!message}>
            {message}
        </p>
    );
}

export default PlanBoardDragDrop;
