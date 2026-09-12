# Data flow, storage and deletion

Sidewalk is self-hosted on your Mac but uses external AI and transport providers.

| Data | Destination / storage |
|---|---|
| Microphone audio | Sent directly from iPhone to OpenAI over WebRTC. Sidewalk does not record raw audio files. |
| Transcripts and selected context | Processed by the Mac companion and OpenAI voice/intent APIs. |
| Work requests and Claude replies | Claude Code executes on your Mac under your account. Claude's provider processes its model requests. |
| Phone control traffic | Authenticated HTTPS through Cloudflare. Cloudflare terminates public TLS; this is not application-level end-to-end encryption. |
| Conversation history | SQLite on the Mac; cached chat/state on the iPhone. Claude also maintains its own session history. |
| OpenAI key and tunnel token | Private files on the Mac, never bundled in the iPhone app. |
| Phone credential | Device-only iOS Keychain; hashed credential record on the Mac. |

Mac data lives under `.local`, normally `.local/accounts/personal`. Filesystem permissions protect it; database payloads are not encrypted by Sidewalk. Logs and journals can contain full work text. There is no automatic retention/deletion schedule. Local deletion does not delete provider-retained data. `store:false` is not a zero-retention guarantee; review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and your Claude account's policies.

Each bridge represents one user's workspace. Paired phones can access that bridge's data; separate device tokens do not make it a multi-user service. Treat pairing QR codes as secrets. Never paste keys, pairing payloads, native session logs, journal databases or work screenshots into public issues.

Forget this Mac revokes the paired phone when the companion is reachable. If it is offline, local forgetting alone cannot confirm server-side revocation. To retire a setup, stop its service and sessions, revoke reachable phones, then deliberately remove the intended local data and provider credentials. Deleting `.local` destroys saved work and pairing state. Claude's history and any provider data require their own deletion procedures.

Sidewalk can ask Claude to use tools with your local account's permissions. Screen approval applies to specific requests; starting voice does not grant blanket permission. Review unknown project content and avoid using sensitive work until you understand the configured tools and provider policies.
