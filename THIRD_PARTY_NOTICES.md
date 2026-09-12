# Third-party notices

Sidewalk's original source is MIT licensed. Third-party software retains its own license and copyright notices; Sidewalk's license does not relicense it.

- MCP TypeScript SDK: MIT — https://github.com/modelcontextprotocol/typescript-sdk
- node-pty: MIT — https://github.com/microsoft/node-pty
- ws: MIT — https://github.com/websockets/ws
- Zod: MIT — https://github.com/colinhacks/zod
- WebRTC Swift package: https://github.com/stasel/WebRTC, pinned by apps/ios/Package.resolved. It distributes Google's WebRTC framework and associated third-party code; retain its included notices when distributing binaries.
- cloudflared and Claude Code are separately installed tools, not included or relicensed by this repository. Their respective licenses and service terms apply.

The repository includes source and its small generated waiting-sound asset, not vendor binaries. npm and SwiftPM fetch dependencies from their recorded sources. Anyone distributing a compiled app should audit and retain the notices/licenses for all resolved transitive dependencies and bundled SDKs.
