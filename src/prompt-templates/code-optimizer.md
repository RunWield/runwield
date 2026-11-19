---
description: Optimize functional code for production by enhancing maintainability and clarity.
---

# Code optimization

Improve the maintainability and clarity of functional code for production use.

Operate on the entire codebase, start on the entry point, and walk your way through the imports.

## Optimization Criteria

1. **Simplicity:** Remove unnecessary boilerplate. Use built-in library functions where they improve clarity.
2. **Pragmatic DRY:** Identify repeated logic blocks.
    - Refactor only if the logic is repeated 3+ times OR if the logic is complex enough that a single source of truth is
      safer.
3. **Types** Use named TypeScript types with specific properties and reuse types exported by the owning module.
    - Replace broad types with specific types where the contract supports them.
    - In Python projects add type hints to functions.
4. **Documentation:** -
    - Insert inline comments for complex math: e.g., $A = \pi r^2$ or specific heuristic weights.
    - Explain _why_ a specific assumption was made (e.g., // Assuming the API returns UTC).
5. **Maintainability:** Ensure variables are descriptively named (e.g., `user_account_balance` instead of `bal`).

If a significant refactor is needed, state the concrete limit and offer user-owned options, such as `/agent planner` for
a planned refactor or continuing with a smaller optimization request.
