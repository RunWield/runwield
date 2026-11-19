---
planId: "f5b78c2f-f76c-4d60-a993-22e7620491eb"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "LOW"
affectedPaths:
    - "src/cmd/auth/index.ts"
    - "src/cmd/auth/index.test.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-05T15:16:53-04:00"
status: "draft"
origin: "internal"
---

# Require Login Session Context for Post-Login Setup

## Context

The model-welcome/auth dependency-seam refactor is complete and independently recorded by the verified
`docs/plans/model-welcome-auth-deps-refactor.md` Plan and its Work Record. Model welcome and auth now use the real model
registry, settings, command registry, composed TUI, credential store, and Session Runtime; the old injection seams are
gone.

One small ambiguity remains in `src/cmd/auth/index.ts`. `AuthCommandOptions` declares both `sessionId` and
`sessionRuntime` optional, and `configureInteractiveSessionAfterLogin` silently skips the root Agent switch when either
is absent:

```ts
if (options.sessionId && options.sessionRuntime) {
    await options.sessionRuntime.switchAgent(...);
}
```

There are only two supported login contexts:

1. Ordinary `/login` is slash-only. Slash dispatch always supplies both the current Session ID and its `SessionRuntime`,
   and successful login performs model selection followed by the real Router switch.
2. First-run model welcome calls canonical `/login` with `skipPostLoginSetup: true`; model welcome deliberately owns the
   later `/model` selection and root activation so it can preserve onboarding order and recovery behavior.

Missing Session context with post-login setup enabled is therefore neither a third supported mode nor an external
capability boundary. Silently accepting it can persist credentials and report success while omitting the activation
transaction the caller requested.

This focused Plan is the only actionable remainder from the deleted root-level `model-welcome-auth-deps-refactor.md`
working note. It does not reopen or replace the verified canonical Plan.

## Objective

Represent login's two valid modes explicitly and fail before authentication mutates credentials when ordinary post-login
setup lacks its required Session context.

## Approach

Give login a discriminated context contract:

- `skipPostLoginSetup: true` is the explicit startup/onboarding mode and does not require login itself to activate a
  Session.
- When `skipPostLoginSetup` is absent or false, `sessionId` and `sessionRuntime` are a required pair. Validate that
  contract at the beginning of `runLoginCommand`, before registry hydration, prompts, or credential writes.

Keep `/logout` and `/status` on the smaller UI-only context because neither command performs Session activation. Do not
add a dependency bag, command factory, registry override, or new injection seam. The existing composed-TUI tests remain
the behavioral authority; add only the smallest pure contract coverage needed for the invalid context shapes.

## Files to Modify

- `src/cmd/auth/index.ts` — split the shared options shape into capability-specific auth/login contracts, validate the
  login mode before side effects, and make post-login model selection plus Router activation unconditional after that
  validation.
- `src/cmd/auth/index.test.ts` — retain real slash/composed-TUI behavior tests and add bounded coverage for the login
  context contract without reintroducing hand-built UI or registry fakes.

## Reuse Opportunities

- `src/ui/tui/slash-dispatch.ts` already supplies `sessionId` and `sessionRuntime` together for every slash command.
- `src/ui/tui/model-welcome.ts` already passes `skipPostLoginSetup: true` and performs its own canonical `/model` plus
  `SessionRuntime.switchAgent` sequence.
- The existing `post-login setup shows the model selector and switches the real Session to Router` auth test proves the
  normal positive path through real machinery.
- The existing model-welcome subscription, cancellation, failure, and failed-root-activation tests protect the
  deliberate startup path.

## Implementation Steps

- [ ] Auth command option types distinguish the UI-only `/logout` and `/status` surface from login's post-setup
      requirements; no `any`, `unknown`, or untyped object shape is introduced.
- [ ] `runLoginCommand` accepts exactly two modes: explicit `skipPostLoginSetup: true`, or post-login setup with a
      non-empty `sessionId` and a real `SessionRuntime` reference.
- [ ] Invalid post-login contexts are rejected before `getModelRegistry`, provider prompts, OAuth/API-key login, or
      credential mutation runs, with a message that names the missing interactive Session context.
- [ ] After a normal successful login, model selection and
      `SessionRuntime.switchAgent(..., { agentName: AGENTS.ROUTER
    })` run without the current optional-pair
      conditional.
- [ ] Explicit startup mode still returns after credential setup without opening the auth command's model selector or
      switching Router; `maybeShowModelWelcome` continues to own those later steps.
- [ ] `/logout` and `/status` continue to require only their genuine interactive UI capability and retain their current
      credential/status behavior.
- [ ] Tests preserve the real composed-TUI positive paths and prove the invalid context contract fails before side
      effects. They do not call login with a fake registry, fake SessionRuntime, partial UI dependency bag, or real
      provider credentials.

## Verification Plan

- Automated: run OC1 and OC2 from Front Matter.
- Automated: `deno task check`.
- Automated: `deno task ci`.
- Automated: `deno task test:golden-tui` to preserve the real first-run welcome and provider-without-model startup
  scenarios.
- Manual: in an interactive Session, run `/login api-key <fixture-provider>`, select a model, and confirm the current
  Session activates Router.
- Existing behavior to preserve: OAuth success/cancellation/failure, API-key persistence, logout, status, model-welcome
  cancellation through real `/quit`, failed root activation recovery, and fixture-HOME isolation.
- Expected behavior to stop existing: a non-startup login can persist credentials and report success while silently
  skipping model selection or Router activation because Session context was absent.

## Edge Cases & Considerations

- Validate before authentication begins. Rejecting only inside `configureInteractiveSessionAfterLogin` would still leave
  credentials changed after an invalid invocation.
- `skipPostLoginSetup` is not a generic escape hatch. It exists for model welcome, whose immediately following code
  demonstrably owns `/model` and root activation.
- Do not require Session context for `/logout` or `/status`; those commands have no Session transition to perform.
- Do not alter Pi OAuth internals or add fake OAuth protocol behavior. The scripted provider remains the genuine
  external-boundary fixture.
