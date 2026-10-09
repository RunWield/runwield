# User documentation

This folder is the source for the user manual at [docs.runwield.dev](https://docs.runwield.dev). Every page here is
written for people who use RunWield, not for people who change it.

`scripts/public-docs.ts` lists the pages that are published. Each page publishes at the site root: `settings.md` becomes
`https://docs.runwield.dev/settings/`. This README is not published.

## What belongs here

- How to install, configure, and use RunWield: commands, settings, workflows, and what the user sees.
- What the user can do when something goes wrong.

## What does not belong here

- How RunWield works internally: module names, state files, events, locks, or recovery records. Put that in the
  contributor docs, such as `docs/architecture.md` or `docs/plan-lifecycle.md`.
- Product requirements, plans, research, or test evidence. Those belong in `docs/prd/`, `docs/plans/`, and
  `docs/research/`.
- Work in progress or roadmap notes. Document a feature here when users can use it.
- Paths under `src/`. Users who install the binary don't have the source.

## Writing rules

- Explain each topic on one page and link to it from other pages instead of repeating it.
- Lead with what the user wants to do, then how to do it. Use lists and tables instead of long paragraphs.
- Link to other pages in this folder with relative links, such as `[Settings](settings.md#imagegeneration)`. The site
  rewrites them to site routes.

## Contributing section

The site also publishes a Contributing section from `docs/contributing.md`, `docs/plan-lifecycle.md`,
`docs/validation-authority.md`, and the five central PRDs in `docs/prd/`. Those pages are for contributors and live
outside this folder.
