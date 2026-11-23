---
name: Show the Work
description: "How planning agents explain a design — diagrams, call paths, pseudo code, and trade-offs instead of dense prose."
---

## Show the Work

Explain the work the way you would at a whiteboard with a coworker: draw the boxes, walk the call stack, write the three
lines of pseudocode, for UI work a very simplified version of what the user sees in the app, say which option you would
pick and what it costs. A person reads what you write before an agent executes it, and prose built from internal labels
can be correct while still forcing that reader to rebuild the picture you already had.

### Write less

Long dense paragraphs are hard to read. Most of the fix is prose, not pictures:

- **One idea per paragraph.** Three or four lines. When a paragraph covers two things, split it.
- **Lead with the point.** The conclusion goes first; the reasoning follows. Do not build up to it.
- **Break a sequence into a list.** A paragraph naming four files, steps, or conditions in a row should be four lines.
- **Cut the throat-clearing.** No preamble, no restating the section heading, no summarizing what you just said.
- **Cut hedges and filler.** "It is important to note that", "in order to", "essentially", "various". Say the thing.
- **One sentence, one clause chain.** If a sentence needs a third comma to stay upright, make it two sentences.

Bold the load-bearing phrase in a long list so a reader scanning it can stop at the right line. Use it on the handful of
lines that carry the decision, not on every line.

A section a reader has to re-read is not more precise than one they read once. Cutting words is not cutting detail —
keep every file, symbol, state, and check, and drop the connective prose wrapped around them.

### Show it instead

Some ideas stay dense no matter how the sentence is written, because the reader has to rebuild a structure from a list
of names. Draw those. Pick the smallest form that carries the idea, and put the sketch next to the one or two sentences
it supports rather than in a section of its own.

**A rule or a tricky branch — pseudo code.** Write the decision, not the syntax:

```text
on(plan write)
  if front matter is unchanged
    keep the existing lifecycle state
  write the new body
  re-run validation
```

**Order, and where new work enters — a call path:**

```text
plan_written
  validateFrontMatter
  persistPlan
```

**UI structure — a component tree,** carrying the file, the state hooks, and the module boundaries that matter:

```tsx
<PlanView> (src/ui/workspace/PlanView.jsx)
  usePlanEvents()
  <PlanToolbar>
    <ApproveButton> (src/ui/design-system)
```

**File ownership, or a refactor that moves things — a shallow file tree** with one clause per entry:

```text
src/shared/workflow/
├── plan-actions.ts       # applies a lifecycle transition
├── controller-registry.ts # owns which controller handles a Plan
└── sequence-review.ts    # decides when a Sequence advances
```

**What talks to what, a flow, or a state machine — a `mermaid` diagram.** Keep it terminal-readable: a completed,
top-level fence marked exactly `mermaid`, `graph TD` or another vertical layout, few nodes, short labels, and
conservative syntax from common flowchart, sequence, state, class, and ER examples, with no directives or styling. Split
a broad concept into narrow diagrams rather than one dense map, and state the point in prose beside the fence so it
survives a terminal falling back to raw source.

### Show a change as a diff

When the shape already exists and only part of it moves, a diff beats a before-and-after pair: the reader sees the
change and its surroundings at once. Match the diff to whichever shape above fits the topic — a diff is not only for
source lines.

A control-flow change:

```diff
 on(plan write)
-  write the new body
+  if front matter is unchanged
+    keep the existing lifecycle state
+  write the new body
+  re-run validation
```

A call-path change:

```diff
 plan_written
   validateFrontMatter
+  reconcileSequence
   persistPlan
```

A file-layout change:

```diff
 src/shared/workflow/
+├── sequence-review.ts   # decides when a Sequence advances
-└── plan-actions.ts      # transitions and Sequence advancement
+└── plan-actions.ts      # transitions only
```

Show a whole block instead of a diff when most of it is new, when the omitted context would hide ownership or ordering,
or when the reader needs a target shape they can copy:

```ts
export function reconcileSequence(sequence: SequenceState): SequenceState {
    if (sequence.pendingChildren.length > 0) return sequence;
    return { ...sequence, status: "complete" };
}
```

### Show the trade-off

When you recommend a path, show what you gave up: the option you set aside, what it would have cost, and what would
change your mind. A recommendation with the reasoning stripped out is not something the user can disagree with. Two or
three options against the same criteria fit a short table better than paragraphs.

### Where this applies

**Explaining sections take all of it** — context, the problem, the approach, the flows you traced, the risks, the choice
you made. A person reads those to decide whether the design is right.

**Instruction sections take the prose rules only.** Implementation Steps and the Verification Plan are the contract an
Engineer executes against. Keep them short and direct, but never trade a detail for brevity: they name exact files,
symbols, states, and commands. A sketch in Approach can show where a step lands. It does not replace the step, and no
step becomes a tree or a diagram.

### Restraint

You will use one or two of these forms, sometimes several, almost never all of them. None is required.

A two-file bug fix needs a sentence. A diagram repeating what a sentence already said makes the document worse. Keep
only the calls, files, props, states, and boundaries that answer the question in front of you.
