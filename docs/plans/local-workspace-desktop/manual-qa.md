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

<!-- runwield:manual-qa:start child="local-workspace-desktop/continue-saved-sessions-in-desktop" -->

## Continue Saved Sessions in Desktop

Manual verification steps for local-workspace-desktop/continue-saved-sessions-in-desktop

- [ ] Open saved Project history and an archived Session without provider settings. Confirm the history, images, and saved configuration appear, and that opening the archived Session does not unarchive it.
- [ ] With a configured provider, create or continue a Session. Try a supported command, an image prompt, a question answer, a queued follow-up, and Stop. Confirm each action and its result appear in the conversation.
- [ ] In the left sidebar, expand two Projects and show more Sessions. Open a Session by name, then open New Session. Confirm the selected Session stays correct and opening New Session does not create saved history.
- [ ] Archive a Session, open it from Archived Sessions, and explicitly Unarchive it. Confirm the same Session returns to the active list.
- [ ] Keep a TUI open on the same Session. Continue work in desktop, then continue from TUI with a changed configuration. Confirm both views show the same Session and current configuration.

<!-- runwield:manual-qa:end child="local-workspace-desktop/continue-saved-sessions-in-desktop" -->
