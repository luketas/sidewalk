# Mac setup and reconnection

Run commands from the repository root. `npm run doctor` checks local prerequisites without printing credentials or making model calls.

## Permanent internet address

Create a named Cloudflare Tunnel for your Mac and assign a public hostname under a domain you control. Set its published application service to **HTTP**, `127.0.0.1:17842`. Follow [Cloudflare's setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/). Sidewalk starts its own cloudflared connector; do not also install a separate connector service for this setup.

Save the tunnel token as a text file accessible only to your macOS user. In a zsh Terminal, the following prompts without echoing the token or putting it in shell history:

```sh
mkdir -p .local/secrets
chmod 700 .local/secrets
read -s 'SIDEWALK_TOKEN?Paste tunnel token, then press Return: '
print -rn -- "$SIDEWALK_TOKEN" > .local/secrets/tunnel-token
chmod 600 .local/secrets/tunnel-token
unset SIDEWALK_TOKEN
export SIDEWALK_REMOTE_URL=https://your-mac.your-domain.example
export SIDEWALK_TUNNEL_TOKEN_FILE="$PWD/.local/secrets/tunnel-token"
npm run personal -- remote
```

Replace the example hostname with the one you configured. The hostname must have no path, query or credentials. A browser-login Cloudflare Access gate is not supported by the native app. Sidewalk authenticates API requests with its own device credentials; never expose a second unauthenticated bridge or use a shared journal across users.

Wait for the public connection to become ready, then `npm run pair` in another terminal and scan the new code once. The URL now survives companion restarts. Setup code expiry does not expire a paired device.

## Start automatically after login

First complete Claude login, save the OpenAI key with `npm run configure-key`, and successfully connect through the named tunnel. Stop the foreground companion with Ctrl-C. In the terminal where the two tunnel variables are set:

```sh
npm run autostart -- install
npm run autostart -- status
npm run pair
```

The installer registers a LaunchAgent for this clone and starts it. It saves paths and connection settings, not provider keys, in the agent configuration. The source directory and Node installation must stay at their current locations. Service output goes to `.local/service/stdout.log` and `stderr.log`; these are private diagnostics and may contain sensitive work details. macOS may request permission to access the source folder; a clone under `~/Developer` avoids protected Documents/Desktop folders.

The service starts after **user login**, not before FileVault unlock or while the Mac is asleep. With the stable URL and original journal intact, the phone keeps its credential. Claude sessions can need Reconnect after restart; Sidewalk will not automatically repeat uncertain work. Check actual readiness in the phone before talking.

To preview the configuration without loading a service, use `npm run autostart -- install --dry-run`. Remove startup with `npm run autostart -- uninstall`; it stops the service but keeps your data and login. Stop active work before maintenance. After updating Node or moving the clone, reinstall the agent with the intended settings.

## Choose a project

The helper initially registers a blank playground. To add a project you intend Claude to access:

```sh
SIDEWALK_DATA_DIR="$PWD/.local/accounts/personal/bridge" npm run setup -- /absolute/path/to/project
```

Restart the companion to load the updated project list. Project IDs currently derive from folder names: avoid registering two folders with the same basename. Two threads using the same project share its checkout. Use separate directories/worktrees when isolation matters.

## Troubleshooting

| Symptom | Check |
|---|---|
| Cannot find hostname | A temporary tunnel may have changed. Wait for the current public URL, renew the QR, then Update connection. Test that URL's `/health` in phone Safari. |
| Pairing expired | Run `npm run pair` again. Do not restart just to renew a QR. |
| QR helper gets no response | Run the current compiled companion, wait for internet readiness, and check you chose the same data directory. |
| Mac unavailable after reboot | Confirm user login, `npm run autostart -- status`, stable tunnel settings and `.local/service` logs. |
| Claude startup needs attention | Review its native prompts using `npm run personal -- terminal THREAD_UUID`. Control-] detaches; it does not cancel work. |
| Team account rejected | The guided personal helper intentionally accepts Pro/Max only. See [Team accounts](team-accounts.md). |
| Voice unavailable | Check the private key file and your OpenAI project's model access/billing. A ChatGPT subscription alone does not configure API usage. |
| Thread marked unknown | Reconnect/check the existing thread. Do not keep creating new tasks to repeat possibly running work. |

For same-Wi-Fi experiments use `npm run personal -- wifi` instead. This pins the local certificate from the QR and requires a new QR if the Mac's IP changes; it is not the off-Wi-Fi path.

## Updating and uninstalling

Stop active work and the companion before updating source with `git pull`, `npm ci`, `npm run check`. Restart the companion or reinstall its login agent. Keep `.local` to preserve pairing, account binding and history. Never copy that folder to another user's installation.

To uninstall, remove login startup, stop any remaining companion/Claude processes you started, and Forget this Mac on the phone while connected. Back up or delete your own `.local` data deliberately; it contains history and credentials. Claude's isolated login/session data may also need removal through Claude's account tools. No uninstall command silently erases your work.
