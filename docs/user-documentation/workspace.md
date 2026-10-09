# Use Workspace on your computer and phone

Workspace is RunWield in your browser. Your repository, tools, and agents run on your computer; your phone opens the
same Sessions. You can start in the TUI, continue on your phone, and return to the TUI.

All terminal commands below run on the computer that holds your repository.

## Before you start

Install RunWield and configure a model provider using the [Quickstart](quickstart.md). You should be able to run `wld`
and get a reply in your project. Workspace uses those same credentials.

## Start Workspace locally

In a terminal on your computer, run:

```bash
wld workspace serve
```

This starts Workspace at `http://127.0.0.1:8787` and opens your browser. Keep this terminal running. One Workspace
server can show multiple projects.

### Pair your browser

The first visit shows **Authorize this browser**, a device label, and a short code.

1. Give the browser a recognizable label, such as `Laptop Chrome`.
2. Copy the command shown on the page.
3. Run it in a **second terminal on the same computer**, using your actual code:

   ```bash
   wld workspace pair ABC123
   ```

The browser opens Workspace automatically after approval. It remembers the pairing across visits. A new browser or
cleared cookies require pairing again.

### Link your repository

Open **Projects** → **Link a Project**. Enter the absolute path to your repository in **Project root**, optionally give
it a display name, and click **Link Project**.

For example, use `/Users/alex/code/my-app` on macOS or `/home/alex/code/my-app` on Linux. This is the path on the
computer running Workspace, including when you enter it from your phone. Run `pwd` in your repository if you need the
path.

Your project and its Sessions now appear in the sidebar. Open a Session or choose **New Session** to start one.

## Connect from your phone with Tailscale

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) gives Workspace an HTTPS address reachable from
your Tailscale devices. Set this up once on the computer running Workspace.

### 1. Connect both devices

Install [Tailscale](https://tailscale.com/download) on your computer and phone, sign in to the same account, and turn it
on on both devices. On your computer, check that the CLI works:

```bash
tailscale status
```

If the command is missing, follow the [Tailscale CLI setup](https://tailscale.com/docs/reference/tailscale-cli).

### 2. Get your Workspace address

On your computer, run:

```bash
tailscale serve --bg --https=443 127.0.0.1:8787
```

If Tailscale asks you to enable HTTPS, follow the link it prints and then retry the command. Copy the resulting
`https://…ts.net` address. You can display it again with:

```bash
tailscale serve status
```

The output should look like this, with your computer's actual name:

```text
https://my-laptop.example.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787
```

The `--bg` option keeps Tailscale's forwarding running after this command exits. It does not start RunWield.

### 3. Start Workspace with that address

If the local Workspace server is still running, press **Ctrl+C** in its terminal first. Then run this command, replacing
the example URL with the exact HTTPS address from step 2:

```bash
wld workspace serve --public-origin https://my-laptop.example.ts.net --no-open
```

Leave this terminal running. It should print `Owner Workspace:` followed by your HTTPS address.

Use that HTTPS address on **both your computer and your phone** now. Once configured this way, Workspace expects that
address; the old `http://127.0.0.1:8787` browser URL will show a Host error. The listener still uses port 8787 locally.

### 4. Pair your phone

Open the HTTPS address in your phone's browser. On **Authorize this browser**, give it a label such as `My phone`, then
run the displayed `wld workspace pair CODE` command in a second terminal on your computer.

The phone should open Workspace and show the projects you already linked. Bookmark the address or add it to your home
screen. Your laptop browser also needs a one-time pairing at this new address.

## Try moving between screens

1. On your computer, run `wld` from the linked repository and send a message.
2. In the TUI, enter `/name Phone test` to make this Session easy to find.
3. Leave the TUI open. On your phone, open **Phone test** in the project's Session list. You should see the same
   conversation.
4. Send the next message from your phone. The reply should also appear in the TUI.
5. Send another message from the TUI and check that it appears on your phone.

You can also begin with **New Session** in Workspace, then run `wld` from that repository and use `/resume` to open it
in the TUI. A truly empty Session is hidden from lists, so send its first message before looking for it elsewhere.

While the agent is working, **Steer** changes its direction and **Queue** schedules a follow-up after the current turn.
Pending steering and queued follow-ups belong to the screen where you sent them; they do not need to move with you.

## Stop and start again

Press **Ctrl+C** in the Workspace server terminal to stop it. Start it again with the same `wld workspace serve` command
you used above. Linked projects and browser pairings are remembered.

For phone access, keep your computer awake, Workspace running, and Tailscale connected on both devices. A sleeping or
powered-off computer cannot run your Sessions.

Tailscale forwarding stays enabled until you turn it off. To disable the forwarding created by this guide:

```bash
tailscale serve --bg --https=443 off
```

See the [Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve) for more options.

## Manage paired browsers

Open `/devices` in Workspace, for example `http://127.0.0.1:8787/devices`, to see every paired browser with its label
and pairing date. **Revoke** signs a browser out. Revoking the browser you're using sends it back to pairing.

## Keep Workspace private

Pairing controls who can use Workspace, but it doesn't encrypt traffic. Plain `http://127.0.0.1` is fine on the same
computer. For any other device, put Workspace behind HTTPS on a private network, as the Tailscale steps above do.
WireGuard with your own HTTPS proxy works too. Never expose port 8787 directly.

If your HTTPS proxy runs on another machine and must reach Workspace over the network, start it like this and firewall
port 8787 so only the proxy can reach it:

```bash
wld workspace serve --bind 0.0.0.0 --port 8787 --trust-tls-terminator \
  --public-origin https://workspace.example.test --no-open
```

Workspace refuses to listen on a non-local address without `--trust-tls-terminator` and an `https://` public origin.

## What Workspace can do

Workspace shows every linked project's Sessions and its Plan Board. From the browser you can continue conversations,
answer an Agent's questions, review Plans and code, and steer or queue messages. Some actions that change your
repository directly, such as running shell commands, still need the terminal.

When a terminal Session is open on the same conversation, it picks up messages sent from Workspace automatically and
keeps whatever you were typing. If both screens send at the same moment, RunWield refreshes the terminal and asks you to
send again.

For a quick Plan Board of the current checkout without linking a project or pairing, run `wld plans ui`.

## Run Workspace in a container

A container setup for running Workspace on a server is coming soon.

## If something does not work

| What you see                  | What to check                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Address already in use        | Another Workspace server is using port 8787. Stop it in the terminal where you started it before starting another.                |
| Host or Origin is not allowed | Use the exact URL passed to `--public-origin`, including `https://`. Restart Workspace if you changed the address.                |
| Phone cannot connect          | Check that the computer is awake, both devices have Tailscale connected, and `tailscale serve status` points to `127.0.0.1:8787`. |
| Bad Gateway / 502             | Tailscale is reachable, but Workspace is not. Start the Workspace server and check its terminal for errors.                       |
| Pairing code expired          | Refresh the pairing page and run the new command on the computer running Workspace.                                               |
| Repository or Session missing | Link the repository under **Projects**, check its absolute path, and send a first message if the Session is empty.                |
