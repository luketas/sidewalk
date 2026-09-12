# Claude Team and Enterprise accounts

The guided public quickstart is verified with an individual Pro account. It intentionally uses a separate profile and rejects Team/Enterprise logins. Do not move a personal journal into a work account or bypass organization policy.

For a future organization pilot, an Owner must enable **Channels** in Claude's Admin settings → Claude Code (`channelsEnabled: true`). **Remote Control** is a separate setting if you want the same local session visible in Claude's browser/mobile Code view. The organization can approve a private channel plugin with `allowedChannelPlugins`; changing this setting replaces the allowlist, so preserve other approved plugins. See [Channels](https://code.claude.com/docs/en/channels) and [Remote Control](https://code.claude.com/docs/en/remote-control).

The current custom channel uses the development flag. It cannot override the Channels master switch. A regular organization rollout still needs a packaged, approved channel plugin, namespaced tool configuration, an explicitly bound Team profile and real-account validation. Those are planned, not included as a working Team setup command in this release.

Each participant should run an isolated companion on their own Mac, with their own intended Claude login and approved OpenAI API project. Claude Team access does not include OpenAI voice API billing. Work audio, selected conversation context and the Cloudflare control connection need to fit the organization's provider policies.

When Team support is implemented, acceptance must cover a real work request, progress, screen permission, voice result, full text in the same Claude session, follow-up and resume without duplicate execution. Personal account tests do not establish Team compatibility.
