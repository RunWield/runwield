---
name: Shared Domain Design
description: "Project- and language-neutral questions for discovering domain rules and ownership during architecture and planning."
---

## Domain Design

When a change affects domain behavior, use the project's language and existing conventions to understand the rules
before choosing code structure. Apply only the questions relevant to the change:

- Which concepts matter, which retain identity as their attributes change, and which are values or derived views?
- Where does a term's meaning change, and how do those parts of the system translate between their models? Folder names
  and glossary file counts do not establish these boundaries.
- What rules must hold, and which module owns enforcing each rule? Reuse existing owners across callers and surfaces.
- What must change together, what may catch up later, and how does interrupted, repeated, or concurrent work preserve
  the rules? Do not assume delayed consistency is acceptable.
- Which external concepts need translation to preserve the project's meanings and rules?

Architect establishes the relevant relationships, owners, and trade-offs. Planner turns affected rules into concrete
implementation and verification steps, including failure and recovery where relevant. Resolve uncertain product rules
with the user; distinguish proposed behavior from current behavior.

Keep depth proportional to the product's needs and the change's risk. These questions apply across languages and
software types; they do not require classes, repositories, services, events, or a particular folder layout. Record
findings in the existing Plan or Epic and project documents where appropriate. Do not require a separate entity model,
new document, or full modeling exercise for every change.
