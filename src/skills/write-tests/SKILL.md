---
name: write-tests
description: Decide whether automated tests contribute meaningful protection, then write, update, repair, or prune them. Use for test coverage, flaky tests, regression tests, and test-value reviews. Language/framework-agnostic. For an explicitly requested test-driven workflow, also use a TDD skill if available.
license: MIT; complete terms in LICENSE
---

# Write Tests

Use this skill to decide which automated tests are worth creating or retaining, then write or update them. It is
language- and framework-agnostic; adapt its principles to the project's installed test stack.
Use the target repository's terminology, requirements, fixtures, commands, and validation workflow.

## Philosophy

**Tests verify behavior through public interfaces, not implementation details.** A good test tells you _what_ the system
does, not _how_ it does it. Bad tests are coupled to internal structure and break on refactors that don't change
behavior.

## Decide Whether a Test Is Warranted

Before creating a test, ask:

> What meaningful failure would this test catch, through a supported interface, against an expectation established
> independently of the implementation?

Check four things:

- **Promise:** Name the user outcome or substantive caller contract. Derive expected behavior from requirements,
  acceptance scenarios, a reported bug, a protocol, or an explicit invariant before reading how the code implements it.
  Copying the algorithm or capturing today's output can preserve the same mistake in both code and test.
- **Reality:** Exercise the relevant product-owned machinery through a meaningful module or system interface, with
  real internal collaborators. An exported helper is not automatically a meaningful boundary.
- **Sensitivity:** Name a plausible wrong implementation the assertions would detect. A test that only proves its
  setup or its mocks worked contributes no protection.
- **Contribution:** Inspect existing coverage. Identify the distinct failure or condition this test adds, and weigh
  that protection against setup, runtime, flakiness, and maintenance cost. Extend an existing scenario when that
  expresses the missing protection clearly.

**You may skip creating a test when it adds no meaningful protection.** A changed function, more assertions, a coverage
percentage, or the ease of generating a test is not sufficient justification. Trivial delegation, implementation-only
refactors already covered through a public contract, and duplicate happy paths usually need no new test. Briefly state
the reason and identify existing protection when relying on it; no approval is needed for this judgment unless the
user explicitly requires that test. Skipping a new test does not waive applicable validation or justify leaving a
meaningful new behavior unverified because its fixture is difficult.

Small tests can earn their place by protecting a substantive contract. Large end-to-end tests must earn theirs too;
test size, abstraction height, and the unit/integration label are not measures of value.

When pruning tests within the requested scope, apply the same questions. Delete tests with no meaningful contribution.
If a poorly structured test is the only protection for an important behavior, replace that protection through the
appropriate interface before removing it. Preserve distinct failure conditions when consolidating tests.

### Signs of a good test

- Tests behavior users or callers care about (the "what")
- Uses the module's public API only
- Survives internal refactors (rename a private helper? test shouldn't care)
- One coherent behavior or journey per test, with the assertions needed to establish its outcome
- Deterministic: same input always produces the same pass/fail
- Fast enough to run frequently

### Signs of a bad test

- Mocks internal collaborators of the module under test
- Tests private methods or internal state
- Asserts on call counts or call order of mocks
- Test name describes _how_ (e.g., "calls paymentService.process") not _what_ (e.g., "charges the user's card")
- Test breaks when you refactor without changing observable behavior
- Verifies through external means instead of the module's own interface (e.g., querying a database directly after
  calling a function instead of calling a retrieval function)

## Before You Write

1. **Discover the project's conventions**
    - Read existing tests to identify framework, assertion style, file naming, and fixture patterns.
    - Check project configuration files (package manager, build scripts, test runner config).
    - If the project has a memory store, recall testing preferences.
    - If framework-specific skills exist in the project or user's global skills (e.g., `playwright`, `pytest`, `vitest`),
      load them for detailed guidance.

2. **Understand what to test**
    - Apply the warrant questions above before writing. Establish expectations, then inspect the implementation to
      locate the supported interface and build realistic fixtures.
    - Prioritize meaningful uncovered outcomes and failure conditions, not a test for every function or branch.
    - Do not invent tests for behaviors that were not requested unless they protect against evidenced regression risk.
    - One test = one focused behavior. Do not combine multiple scenarios into a single assertion block.

3. **Shape the test module around one behavioral domain**
    - Before appending to an existing file, inspect what contracts it already owns and whether it is becoming a
      mixed-responsibility or serial-critical module.
    - Group tests by behavioral/domain contract, not by convenience of shared setup.
    - If unrelated behaviors are colocated or one module is concentrating the runner's critical path, split the module
      first and extract only fixtures that are safe to use in parallel.
    - This step is complete when every changed test has one clear domain home and unrelated behavior is not colocated
      merely to reuse setup.

4. **Know what not to test**
    - Implementation details (private functions, internal state transitions not exposed through the interface)
    - Trivial delegation (a function that simply passes through to another function)
    - Third-party library behavior (assume the library works, test that your code uses it correctly)

## How to Write Tests

### Choose a meaningful observation boundary

- **Module contracts:** Exercise a complete capability through the interface its callers use, keeping internal
  persistence, transactions, locks, and state transitions real. Prefer this level when it can establish the promise
  without driving an entire application.
- **Golden journeys:** Map each scenario to a user journey or acceptance scenario. Drive the real entry points and
  assert observable outcomes at meaningful checkpoints and completion. Golden output needs independently justified
  expectations; a transcript snapshot alone does not prove the journey succeeded.
- **Robustness scenarios:** Deliberately damage real fixtures or introduce adverse conditions: truncated files,
  inconsistent records, interrupted operations, contention, or unavailable external services. Assert the contract
  under those conditions: what survives, what can resume, what remains isolated, and what the caller is told. An
  assertion that merely expects an error is insufficient when preservation or recovery is part of the promise.

For example, interrupt a resumable file upload, restart it, and verify the completed file has the expected content
without reporting success for partial data. Keep storage and recovery real; control only genuine external boundaries.
Select conditions from the contract and credible failure modes rather than generating every imaginable permutation.

### Fake the environment, never your own machinery

A test's value is in how much real behavior it runs. Fake the _environment_ — a temp directory, fixture files, a
throwaway repo, a fixed clock — and let your own code paths actually execute.

**Never substitute your own core machinery with a stand-in because a test is inconvenient to set up.** State machines,
persistence layers, transaction boundaries, and locking are the code under test even when they are not the subject of
the test. A stand-in for those makes the suite pass while the guarantee it exists to protect goes unverified, and it
hides real defects: production code that mishandles the real mechanism still looks green.

This failure mode is worst when the substitution is conditional. A helper that swaps the real implementation for a no-op
"only in tests" silently disarms every test in the file, and the more dependencies a test injects, the less of your
system it touches. If a test needs twenty injected dependencies to prove one function returns the right value, it is
asserting its own wiring.

A placeholder that isn't a real thing — a path like `/project` or `/tmp/fake` that no directory backs, an id no record
uses — is a signal the test needs a real fixture, not a more elaborate fake.

Order of preference:

1. **The real object.** Use it wherever practical.
2. **Fakes at genuine external boundaries** — controlled implementations of services outside the product. Keep the
   product's own adapters and storage behavior real; an in-memory substitute cannot prove durability or locking.
3. **Mocks only at system boundaries** — external APIs you don't control, paid services, hardware, the network.

### Faking an external boundary, and what you still owe

Faking a genuine boundary is correct and usually necessary: it is slow, it is not yours, and you are not testing it.
Cover materially different outcomes your code derives from it, including consequential failures. Apply the contribution
check to these scenarios too. A faked boundary is a way to reach your own error handling cheaply, not a reason to skip it.

When a decision depends on external evidence, distinguish confirmation, refusal, and inability to determine the answer.
Empty, unreadable, timed-out, or truncated output can mean "could not tell". Assert the contract's safe behavior under
uncertainty, such as preserving work and withholding a success claim. Use representative cases unless different causes
require different observable behavior.

But faking a boundary cannot verify that you are _calling_ it correctly. A wrong flag, a reversed argument, or a misread
exit code stays wrong forever behind a fake, because the fake answers the question you assumed rather than the one you
asked. Where behavior turns on the real semantics of an external command, keep a **small number of contract tests** that
run the real thing — enough to pin the meaning, not enough to slow the suite.

Signs you owe a contract test:

- Correctness rests on what a command _means_ (an ancestry check, a lock acquisition, a comparison's argument order).
- The code treats the boundary's answer as proof of something it will then act on irreversibly.
- A fixture that omits the boundary entirely still produces the expected result — the test would pass with the call
  reversed, misspelled, or removed.

That last one is the test to run on your own tests: if the boundary call were subtly wrong, would anything fail? Verify
it directly by breaking the call on purpose and confirming a test goes red.

### Respect the project's boundary policy

Check whether the repository enforces dependency-injection boundaries in CI. Follow its existing policy; do not weaken
a check or re-baseline a violation to make a test pass. A repository without such enforcement does not need a new CI
system merely to add tests. Keep product-owned machinery real using its existing fixtures and interfaces.

Before reaching for a fake on cost grounds, measure. "Real is too slow" is usually true of the _setup_ rather than the
operations, and those have very different fixes. One worked example: individual Git commands measured 5–30ms each, while
building a repository from scratch cost 29–71ms — so the answer was to build one fixture per test module and copy it for
each test (5ms), not to fake Git at all. Reuse beats substitution whenever the real thing is fast once it exists. Save
fakes for boundaries measured in seconds: model or agent calls, CI runs, network round trips.

```typescript
// GOOD: real collaborator, real fixture
test("order total includes tax", () => {
    const taxCalculator = new TaxCalculator(0.08); // real object
    const order = new Order(taxCalculator);
    order.addItem({ price: 100 });
    expect(order.total).toBe(108);
});

// AVOID: mocking an internal collaborator you control
test("order total includes tax", () => {
    const mockTax = { apply: jest.fn().mockReturnValue(108) };
    const order = new Order(mockTax);
    order.addItem({ price: 100 });
    expect(mockTax.apply).toHaveBeenCalledWith(100);
});

// GOOD: only the external boundary is faked, so every branch that derives from it is
// cheap to reach — and all of them are covered, failures included.
test("keeps the order unpaid when the payment gateway declines", async () => {
    const store = await makeTempStore(); // real files, real state machine
    const result = await checkout(store, "order-1", { gateway: { charge: () => Promise.reject(declined()) } });
    expect(result.status).toBe("payment_failed");
    expect(await readOrder(store, "order-1")).toMatchObject({ status: "unpaid" });
});

// NEVER: swapping out your own transaction boundary because the fixture was awkward
const runTransaction = testDeps ? fakeThatJustCallsTheCallback : realTransaction;
```

### Test through the public interface

Do not bypass your own code to verify state. Verify through the same interface a caller would use.

```typescript
// BAD: Bypasses the interface to inspect database state
test("createUser saves to database", async () => {
    await createUser({ name: "Alice" });
    const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
    expect(row).toBeDefined();
});

// GOOD: Verifies through the public API
test("createUser makes user retrievable", async () => {
    const user = await createUser({ name: "Alice" });
    const retrieved = await getUser(user.id);
    expect(retrieved.name).toBe("Alice");
});
```

### Make tests deterministic

- Do not depend on shared mutable state between tests.
- Each test should create its own fixtures from scratch.
- For code that uses clocks or random numbers, inject those values explicitly.

### Name tests by behavior, not implementation

```typescript
// GOOD: Describes the behavior
test("rejects expired credit cards");

// BAD: Describes the implementation
test("calls validateExpiry on the payment service");
```

### Regression tests for bugs

**Reproduce the bug with a failing test, then fix the bug and make that test pass.** A confirmed bug is concrete evidence
of regression risk; the contribution check chooses the right coverage rather than excusing reproduction. First run an
existing test that should expose it. If none does, extend a scenario or add a regression test through the smallest
meaningful public boundary that reproduces the failure. An existing test that already fails on the bug supplies the
red phase; a duplicate adds nothing.

Establish the expected outcome from the bug report and intended contract, and confirm the failure is caused by the bug,
not broken setup. Preserve the assertion while fixing the implementation. If an automated reproduction is infeasible,
state the concrete limitation, use the strongest repeatable reproduction available, and report the remaining coverage
gap rather than calling the test unnecessary.

The regression coverage should:

1. Prove the bug exists (test fails before fix)
2. Prove the bug is fixed (test passes after fix)
3. Remain while the contract is relevant and the coverage contributes distinct protection; consolidate or replace it
   when equivalent protection exists elsewhere

## After Writing

1. **Run the new tests** — verify they pass (or fail as expected for a bug reproduction).
2. **Confirm each new behavior's test can fail.** Break the behavior on purpose — invert a condition, drop the call,
   return the wrong value — and check that this test, specifically, goes red. Then undo it.

    Passing is the weaker signal: a test that asserts nothing also passes, and you cannot tell which kind you wrote by
    watching it pass. This is per distinct behavior, not per assertion — rewriting twelve tests over one behavior earns
    one mutation, not twelve.

    It is worth the minute it costs. A test whose fixture over-specifies, whose subject is faked out from under it, or
    whose assertion was quietly satisfied by the setup will pass forever and protect nothing, and the only cheap way to
    find out is to make the code wrong once.

3. **Run focused tests, then required validation** — use the repository's supported commands and follow the active
   workflow's validation requirements. If that workflow explicitly assigns full validation to an orchestrator after
   handoff, report it as pending instead of duplicating the run or claiming success. Otherwise run the required
   validation yourself. Run it earlier when diagnosis or an explicit user instruction requires it.
4. **Iterate** — if a test fails because your test code is flawed, fix the test. If the test reveals an implementation
   bug, fix the implementation. If the fix is outside your assigned scope, document the failure clearly.

## Stack-Agnostic Adaptability

This skill does not dictate a language, framework, or test runner. Adapt its principles:

- **JavaScript/TypeScript**: `vitest`, `jest`, `mocha`, `node:test`, `deno test`
- **Python**: `pytest`, `unittest`
- **Go**: `testing` package, `testify`
- **Rust**: `cargo test`, `rstest`

If the project has framework-specific skills loaded, read them after this skill for detailed syntax and conventions.
