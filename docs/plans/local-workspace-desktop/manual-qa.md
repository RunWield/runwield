# Manual QA for local-workspace-desktop

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="local-workspace-desktop/run-a-real-session-in-electron" -->

## Run a Real Session in Electron

Manual verification steps for local-workspace-desktop/run-a-real-session-in-electron

- [ ] Launch the desktop app for a disposable Project with a configured provider. Create a Session, send a prompt, and confirm that streamed text appears before the response completes.
- [ ] Answer a displayed question with a choice, then with Other text. Confirm that the app accepts each answer and continues the Session.
- [ ] Stop a held response, send another prompt, and confirm that the new turn succeeds without duplicate messages or a late question answer.
- [ ] Close the Session, relaunch the app, load the displayed saved Session ID, and confirm that its history appears and the Session can continue.
- [ ] Repeat a simple turn with a separately configured real provider. Check keyboard and focus access, and confirm that controls are not clipped at 1440×900 and a narrower window.

<!-- runwield:manual-qa:end child="local-workspace-desktop/run-a-real-session-in-electron" -->

<!-- runwield:manual-qa:start child="local-workspace-desktop/open-projects-and-configure-providers" -->

## Open Projects and Reuse Provider Configuration

Manual verification steps for local-workspace-desktop/open-projects-and-configure-providers

- [ ] Launch the desktop app with no Project argument. Cancel the native folder picker and confirm that no Project is added. Select an ordinary directory, confirm its path, and link it.
- [ ] Open Project settings. Disable and re-enable the Project, run a full Session rescan, then remove and re-add it. Confirm that the Project disappears when removed and that its files and saved Sessions remain intact.
- [ ] Make a registered directory unavailable. Confirm that its settings remain accessible, relink it, and confirm that the Project opens again.
- [ ] With provider settings already configured through `wld`, open a registered Project and complete a model turn. Confirm that the app uses the configured provider and default model.
- [ ] With no usable provider default, try to start a Session. Confirm that the app shows guidance to configure `wld` and restart, while Project listing and settings remain available.

<!-- runwield:manual-qa:end child="local-workspace-desktop/open-projects-and-configure-providers" -->
