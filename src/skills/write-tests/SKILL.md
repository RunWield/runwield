---
name: write-tests
description: Use this skill to write, update, or repair automated tests for existing code. Use when the task involves adding test coverage, fixing flaky tests, or creating regression tests for bugs. Language/framework-agnostic. For test-driven development, use the tdd skill. For general QA and behavioral verification, use the tester agent.
---

# Write Tests

Use this skill to write or update automated tests for existing code. It is language- and framework-agnostic; adapt its
principles to the project's installed test stack.

## Philosophy

**Tests verify behavior through public interfaces, not implementation details.** A good test tells you _what_ the system
does, not _how_ it does it. Bad tests are coupled to internal structure and break on refactors that don't change
behavior.

### Signs of a good test

- Tests behavior users or callers care about (the "what")
- Uses the module's public API only
- Survives internal refactors (rename a private helper? test shouldn't care)
- One logical assertion per test
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
    - Read the implementation code. Identify the public API or module contract.
    - Prioritize: happy path first, then edge cases, then error handling.
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
2. **Fakes** — lightweight in-memory implementations of the same interface (e.g. an in-memory database instead of
   mocking the database client).
3. **Mocks only at system boundaries** — external APIs you don't control, paid services, hardware, the network.

### Faking an external boundary, and what you still owe

Faking a genuine boundary is correct and usually necessary: it is slow, it is not yours, and you are not testing it. The
obligation that comes with it is to test everything derived from it — the happy path _and_ every failure it can hand
you. A faked boundary is a way to reach your own error handling cheaply, not a reason to skip it.

For each check, test three cases: a positive yes, a positive no, and could not tell. Empty, unreadable, timed-out,
truncated, or unknown output means "could not tell". In that test, assert that the code takes the safe path: it keeps
the item and does not report success.

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

### Enforce it, do not just advise it

Guidance loses to convenience. If a project cares about this, the rule belongs in CI as a ratchet, not only in a style
guide:

- Freeze today's seams per module by name — not just a count, or one seam can be swapped for another at a flat total.
- Fail the build on any new seam, on any seam that replaces code the project owns, and on any seam whose value depends
  on whether anything was injected at all.
- Let the baseline tighten and never loosen, so "re-baseline it" cannot make a failure disappear.
- Put the reasoning in the failure output. Whoever hits it — person or agent — is reading the error, not the docs.

Check whether the project already has such a check before adding seams, and if it does, tighten its baseline in the same
change that removes one.

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

When a real bug is found, write the smallest test that reproduces the failure before fixing it. A regression test
should:

1. Prove the bug exists (test fails before fix)
2. Prove the bug is fixed (test passes after fix)
3. Stay in the suite as a permanent guard

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

3. **Run focused tests, then full validation** — in a RunWield-managed implementation or repair, RunWield runs the full
   configured suite after `task_completed`; leave that result pending instead of duplicating the run. Outside that
   workflow, run the full suite yourself. Run it earlier when diagnosis or an explicit user instruction requires it.
4. **Iterate** — if a test fails because your test code is flawed, fix the test. If the test reveals an implementation
   bug, fix the implementation. If the fix is outside your assigned scope, document the failure clearly.

## Stack-Agnostic Adaptability

This skill does not dictate a language, framework, or test runner. Adapt its principles:

- **JavaScript/TypeScript**: `vitest`, `jest`, `mocha`, `node:test`, `deno test`
- **Python**: `pytest`, `unittest`
- **Go**: `testing` package, `testify`
- **Rust**: `cargo test`, `rstest`

If the project has framework-specific skills loaded, read them after this skill for detailed syntax and conventions.
