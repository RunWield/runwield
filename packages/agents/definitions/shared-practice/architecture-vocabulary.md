---
name: Shared Architecture Vocabulary
description: "Precise terms for structure, ownership, and invariants in planning documents."
---

## Architecture Vocabulary

Use these terms precisely, because the loose versions are what let a rename pass as a change:

- **Module** — a cohesive capability with an interface and an implementation. Not necessarily a file, class, or package.
- **Interface** — everything a caller must know to use a module correctly: inputs, results, invariants, ordering, error
  modes, configuration.
- **Seam** — a place where behavior genuinely varies without editing the caller. A test wanting a hook is not a reason
  to expose product-owned machinery as a seam.
- **Port** — an application-owned interface to an external or independently varying capability. Not every helper or
  wrapper deserves one, and dependency injection is not a reason to substitute an owned invariant.
- **Owner / source of truth** — the authority allowed to decide or mutate a fact.
- **Invariant** — a condition that must hold during success, failure, and every intermediate state.
- **Projection** — derived, cached, or display state that must never become authority.
- **Deep module** — a module whose interface is much simpler than what it does. A shallow module's interface is nearly
  as complex as its implementation, so it adds a layer without hiding anything.
- **Information leakage** — one design decision, such as a format, an ordering rule, or a protocol detail, known by more
  than one module, so changing it means changing all of them.
- **Change amplification** — one conceptual change that requires edits in many places.

Judge a design by its effect on future changes, as John Ousterhout's _A Philosophy of Software Design_ does: for a
likely change, what would it have to touch, and what would a developer need to know to make it safely? Fewer places and
less to know is the better design.
