# Contributing

Start with the README and run `npm ci`, `npm run check`, and `npm run eval:intent`. No provider credentials are required for those checks. Keep tests independent of real accounts; paid model and physical-phone checks must be explicitly identified.

For iOS, generate `apps/ios/Sidewalk.xcodeproj` with XcodeGen and run the Sidewalk test scheme on an iOS 26 simulator. Edit `apps/ios/project.yml`, not only the generated project. Never commit signing identities or provisioning profiles.

Preserve these contracts: one authenticated request is dispatched once; uncertain work is reconciled rather than repeated; answers and permissions stay bound to the right thread; account changes cannot reassign an existing journal; the voice host cannot invent Claude's work or results.

Keep changes focused, describe what changed and how it was verified, and note any physical-device limitations. Remove private data from reproductions. See SECURITY.md for vulnerability reporting.

## Optional GitHub Actions checks

Copy `docs/ci-workflow.example.yml` to `.github/workflows/check.yml` in your fork to enable macOS bridge/fixture checks. Pushing workflow files requires GitHub credentials with workflow-write permission. The initial source release ships the example only; local verification is not a claim that hosted CI ran.
