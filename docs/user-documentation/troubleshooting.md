# Troubleshooting

## A helper program is missing

RunWield needs `mnemoteca`, `cymbal`, and `agent-browser` on your `PATH`. Reinstall them the same way you installed
RunWield.

**Shell installer:** run it again. It restores missing helpers next to `wld` and keeps the ones you already have.

```bash
curl -fsSL https://raw.githubusercontent.com/gandazgul/runwield/main/install.sh | bash
```

If you installed to a custom folder, set the same `WLD_INSTALL_DIR` again. To replace a helper the installer put there,
delete it from that folder first.

**Homebrew:**

```bash
brew reinstall gandazgul/tap/wld
brew reinstall gandazgul/tap/mnemoteca
brew reinstall 1broseidon/tap/cymbal ketch agent-browser
```

If you need Mnemoteca data from an install made before it was renamed, run the official [Mnemoteca] installer before
installing RunWield.

## A saved Plan won't load

- Run `wld plans` to see Plan names.
- Load by name with `wld load-plan <name>`, or by path with `wld load-plan docs/plans/<name>.md`.
- `/resume` is for Sessions, not Plans.
- If the Plan file was deleted or damaged while it was running in a worktree, load it by name. See
  [Plan recovery](workflows.md#plan-recovery).

## Merging stopped, or cleanup didn't finish

- Network failures are retried automatically. If retries run out, reconnect and run `wld load-plan <name>` again. Your
  validated commits stay on the work branch.
- If the change merged but cleanup didn't finish, RunWield shows the worktree path and branch. Check them with
  `git status` and `git branch -vv`, save anything you need, then run `wld plans doctor` before deleting anything by
  hand.

## An Agent isn't behaving as expected

- Check for Agent overrides in `.wld/agents/` in the project and in `~/.wld/agents/`. See
  [Customization](customization.md#agents).
- After changing settings, memories, prompt templates, Skills, models, or themes, run `/reload`.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
