# UI Prototype

Generate **several radically different UI variations** in one ignored fixture host, switchable from a floating bottom
bar. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

If the question is about logic/state rather than what something looks like — wrong branch. Use [LOGIC.md](LOGIC.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Fixture host rule

Use an ignored prototype host under `prototypes/<slug>/`; do **not** patch tracked app routes/components to mount
variants. Keep the host realistic by importing stable production design-system modules, CSS tokens, fixtures, and pure
components where practical, but production modules must never import from `prototypes/`.

If realistic integration seems to require editing a tracked route, stop and explain the limitation. Do not bypass the
prototype convention.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being radically different and starts being noise — cap there.

Create `prototypes/<slug>/README.md` with:

- the design question;
- the existing route/surface being approximated;
- the variant keys;
- the run command (`bun run prototype <slug>` in RunWield).

Before writing executable files, confirm the path is ignored:

```bash
git check-ignore prototypes/<slug>/
```

### 2. Build the local host

Use the project's existing browser stack where possible. In RunWield, create `prototypes/<slug>/package.json` with a local
`scripts.dev` command. The host may import RunWield tokens/components from `src/` when that is stable and read-only, or copy a
small fixture when imports would couple the prototype too tightly.

Keep all variant components, switcher code, fixture-only CSS, and route simulation inside the ignored prototype folder.

### 3. Generate radically different variants

Draft each variant. Hold each one to:

- the page's purpose and realistic data density;
- the project's component library / styling system;
- a clear exported component name, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different** — different layout, information hierarchy, or primary affordance, not just
different colours.

### 4. Wire them together

Use a single `?variant=` search param in the ignored host:

```tsx
// pseudo-code — adapt to the project's framework
const variant = new URLSearchParams(location.search).get("variant") ?? "A";
return (
    <>
        {variant === "A" && <VariantA />}
        {variant === "B" && <VariantB />}
        {variant === "C" && <VariantC />}
        <PrototypeSwitcher variants={["A", "B", "C"]} current={variant} />
    </>
);
```

### 5. Build the floating switcher

A small fixed-position bar at the bottom-centre of the screen with:

- left/right arrows that wrap through variants;
- current variant key and label;
- URL updates so the choice is reload-stable;
- keyboard `←` / `→`, without intercepting focused inputs, textareas, or contenteditable elements.

The switcher is part of the ignored host, not shared production UI.

### 6. Hand it over

Surface the local URL and `?variant=` keys. The interesting feedback is usually **"I want the header from B with the
sidebar from C"** — that's the actual design they want.

### 7. Capture the answer and clean up

Once a variant has won, write down which one and why (Plan/PRD/ADR, issue, commit message, or prototype `NOTES.md` while
still local). Then rewrite the validated conclusion into production code with normal tests and error handling. Do not
promote prototype files directly.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype.
- **Sharing too much code between variants.** A shared `<Header>` is fine; a shared `<Layout>` defeats the point.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a
  stub.
- **Editing tracked routes to host the switcher.** The fixture host belongs under `prototypes/<slug>/`.
- **Promoting the prototype directly to production.** Rewrite it properly when you fold it in.
