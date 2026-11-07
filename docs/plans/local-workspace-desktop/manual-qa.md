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
