/**
 * @module shared/workflow/review-ledger
 * Mutable Review Issue Ledger for one semantic review attempt.
 *
 * The ledger is what makes review rounds converge instead of rediscovering the
 * implementation each time. Round one opens it; later rounds resolve items,
 * keep them open, and append newly discovered ones. Identities are stable for
 * the life of the attempt so the Reviewer, the repair agent, and the next round
 * all refer to the same finding.
 *
 * It is plain serializable data because it rides on the active execution
 * workflow record: validation exits whenever it pauses and is re-entered from
 * scratch, so anything held in a loop local is lost on every nudge.
 */

import type { ReviewFinding } from "./review-outcome.ts";

export type ReviewIssueStatus = "new" | "fix_claimed" | "fix_confirmed" | "fix_rejected";

export interface LedgerItem {
    /** Stable identity, e.g. "R1-2". Never reused or renumbered. */
    id: string;
    openedInRound: number;
    resolvedInRound: number | null;
    title: string;
    requirement: string;
    evidence: string;
    /** Optional only for checkpoints written before explicit issue states. */
    status?: ReviewIssueStatus;
    rejectionReason?: string;
}

export interface ReviewLedger {
    items: LedgerItem[];
    /** Monotonic counter backing identity assignment. */
    sequence: number;
}

export function createLedger(): ReviewLedger {
    return { items: [], sequence: 0 };
}

/** Rehydrate a ledger carried across a validation pause, tolerating absent or malformed state. */
export function normalizeLedger(value: unknown): ReviewLedger {
    if (!value || typeof value !== "object") return createLedger();
    const candidate = value as { items?: unknown; sequence?: unknown };
    const items: LedgerItem[] = Array.isArray(candidate.items)
        ? candidate.items.flatMap((entry): LedgerItem[] => {
              if (!entry || typeof entry !== "object") return [];
              const item = entry as Record<string, unknown>;
              if (typeof item.id !== "string" || !item.id) return [];
              return [
                  {
                      id: item.id,
                      openedInRound: typeof item.openedInRound === "number" ? item.openedInRound : 1,
                      resolvedInRound: typeof item.resolvedInRound === "number" ? item.resolvedInRound : null,
                      title: typeof item.title === "string" ? item.title : "",
                      requirement: typeof item.requirement === "string" ? item.requirement : "",
                      evidence: typeof item.evidence === "string" ? item.evidence : "",
                      status:
                          typeof item.resolvedInRound === "number"
                              ? "fix_confirmed"
                              : item.status === "fix_claimed" || item.status === "fix_rejected"
                                ? item.status
                                : "new",
                      rejectionReason: typeof item.rejectionReason === "string" ? item.rejectionReason : "",
                  },
              ];
          })
        : [];
    const sequence =
        typeof candidate.sequence === "number" && candidate.sequence >= items.length
            ? candidate.sequence
            : items.length;
    return { items, sequence };
}

export function openItems(ledger: ReviewLedger): LedgerItem[] {
    return ledger.items.filter((item) => item.resolvedInRound == null);
}

export function resolvedItems(ledger: ReviewLedger): LedgerItem[] {
    return ledger.items.filter((item) => item.resolvedInRound != null);
}

export function hasOpenItems(ledger: ReviewLedger): boolean {
    return openItems(ledger).length > 0;
}

/** Accepted repair completion claims every supplied open issue is settled; only review confirms it. */
export function claimReviewFixes(ledger: ReviewLedger): ReviewLedger {
    return {
        ...ledger,
        items: ledger.items.map((item) =>
            item.resolvedInRound == null ? { ...item, status: "fix_claimed" } : { ...item },
        ),
    };
}

/**
 * Open ledger identities a review result failed to mention.
 *
 * The ledger only converges if every round returns a verdict on every open item.
 * An omission is not neutral: it would let an approval merge over a finding
 * nobody addressed, and it makes a re-reported issue arrive as a new identity
 * beside the original, so one defect becomes two and the count grows each round.
 *
 * @param {ReviewLedger} ledger
 * @param {ReviewFinding[] | undefined} findings
 * @returns {string[]}
 */
export function unaccountedOpenItems(ledger: ReviewLedger, findings: ReviewFinding[] | undefined): string[] {
    const mentioned = new Set(
        (findings || []).map((finding) => finding?.id).filter((id) => typeof id === "string" && id),
    );
    return openItems(ledger)
        .map((item) => item.id)
        .filter((id) => !mentioned.has(id));
}

/**
 * Apply one round's Reviewer result to the ledger.
 *
 * A finding carrying a known id updates that item; `resolved: true` closes it.
 * A finding without a known id is newly discovered and is appended with a fresh
 * identity. Items the Reviewer did not mention stay exactly as they were —
 * silence is not resolution.
 */
export function applyRoundFindings(
    ledger: ReviewLedger,
    findings: ReviewFinding[],
    round: number,
): { ledger: ReviewLedger; resolvedCount: number; appendedCount: number } {
    const next: ReviewLedger = {
        items: ledger.items.map((item) => ({ ...item })),
        sequence: ledger.sequence,
    };
    const byId = new Map(next.items.map((item) => [item.id, item]));
    let resolvedCount = 0;
    let appendedCount = 0;

    for (const finding of findings || []) {
        const existing = finding.id ? byId.get(finding.id) : undefined;
        if (existing) {
            if (finding.title) existing.title = finding.title;
            if (finding.requirement) existing.requirement = finding.requirement;
            if (finding.evidence) existing.evidence = finding.evidence;
            existing.status = finding.resolved ? "fix_confirmed" : "fix_rejected";
            existing.rejectionReason = finding.resolved ? "" : finding.rejectionReason || finding.evidence || "";
            if (finding.resolved && existing.resolvedInRound == null) {
                existing.resolvedInRound = round;
                resolvedCount++;
            } else if (!finding.resolved && existing.resolvedInRound != null) {
                // A later round may reopen an item it previously closed.
                existing.resolvedInRound = null;
            }
            continue;
        }
        // An unknown id means the Reviewer invented or mistyped one. Treat the
        // finding as new rather than dropping a real defect on the floor.
        if (finding.resolved) continue;
        const item: LedgerItem = {
            id: `R${round}-${++next.sequence}`,
            openedInRound: round,
            resolvedInRound: null,
            title: finding.title,
            requirement: finding.requirement || "",
            evidence: finding.evidence || "",
            status: "new",
            rejectionReason: "",
        };
        next.items.push(item);
        byId.set(item.id, item);
        appendedCount++;
    }

    return { ledger: next, resolvedCount, appendedCount };
}

/** Render open items for a Reviewer prompt or a repair packet. */
export function renderOpenItems(ledger: ReviewLedger): string {
    const items = openItems(ledger);
    if (items.length === 0) return "(none)";
    return items.map((item) => formatItem(item)).join("\n\n");
}

/**
 * Render resolved items so a later round can see what was already closed and by
 * which round, without re-litigating it.
 */
export function renderResolvedItems(ledger: ReviewLedger): string {
    const items = resolvedItems(ledger);
    if (items.length === 0) return "(none)";
    return items
        .map((item) => `- ${item.id} — ${item.title} (fix confirmed in round ${item.resolvedInRound})`)
        .join("\n");
}

function formatItem(item: LedgerItem): string {
    const lines = [`${item.id} — ${item.title}`];
    lines.push(`  State: ${(item.status || "new").replaceAll("_", " ")}`);
    if (item.rejectionReason) lines.push(`  Fix rejected because: ${item.rejectionReason}`);
    if (item.requirement) lines.push(`  Plan requirement: ${item.requirement}`);
    if (item.evidence) lines.push(`  Evidence: ${item.evidence}`);
    lines.push(`  Opened in round ${item.openedInRound}`);
    return lines.join("\n");
}
