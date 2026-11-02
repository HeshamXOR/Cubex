# Third-party notices

Cubex is MIT licensed, see [LICENSE](LICENSE). Some of its code was adapted from another project, and some programs it can start or download belong to other people and are used under their terms. This file says which, and carries the notices their licences ask for. The packaged app has a copy of it beside the program, in the `resources` folder.

## T3 Code

The files that install and run Google's Antigravity runtime were ported from T3 Code (https://github.com/pingdotgg/t3code), MIT licence, Copyright (c) 2026 T3 Tools Inc. They were rewritten for Cubex's own structure, checks and wording, and each one says so in its header.

| File | What it took from T3 Code |
|---|---|
| `src/main/peers/antigravity/release.ts` | The pinned release of the runtime: the sizes and SHA-256 hashes of each archive, which T3 Code checked on 2026-10-05 |
| `src/main/peers/antigravity/install.ts` | How a release is installed: the size and hash checks, the check of what the archive holds, the handshake that proves it is the release, and the "active" pointer |
| `src/main/peers/antigravity/profile.ts` | The private profile the runtime runs in, the environment it is given, and the browser helper that reports where Google's sign-in page is |
| `src/main/peers/antigravity/runtime.ts` | Starting the runtime in that profile |
| `src/main/peers/antigravity/signin.ts` | Signing in and signing out |
| `src/main/peers/antigravity/wire.ts` | Putting the runtime's tool calls and questions in the shape the rest of the app reads |

The rest of what Cubex does with other agents was written for Cubex and shares no code with T3 Code. That covers the filter around the runtime, the Claude Code bridge, the permission policy for agents, task delegation, the session pool and the Settings pages. Their design was informed by T3 Code's documentation, which describes how a harness can hand a task to another agent and keep that agent inside the permissions of the chat.

The licence of T3 Code, as it asks to be reproduced:

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Claude Agent SDK for Python

Cubex drives Claude Code over the protocol that program speaks on its standard input and output (`stream-json`, with a permission prompt tool). The shapes of its messages were read from the source of Anthropic's Claude Agent SDK for Python (https://github.com/anthropics/claude-agent-sdk-python), which is that protocol in a library. MIT licence, Copyright (c) 2025 Anthropic, PBC. The bridge in `src/main/peers/claude` is Cubex's own code, and none of the SDK was copied into it.

## Programs Cubex starts or downloads

None of these is part of Cubex, none is redistributed with it, and each stays under its own terms.

- **Google's Antigravity runtime** (`agy_acp_server` and `localharness_external`). Google's software, used under Google's terms (https://antigravity.google/terms). Cubex downloads it from Google's own host, `dl.google.com`, only when you choose **Install the runtime** in Settings, checks it against the size and hash it pins, and keeps it in Cubex's own data folder. **Remove** deletes it. The Antigravity desktop app is a separate program that Cubex never starts or reads.
- **Claude Code.** Anthropic's program. Cubex starts the copy that is already on your PC, from the command line or from the Claude desktop app, and never copies, moves or updates it.
- **The adapters for Claude Code and Codex.** `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` are packages from npm that `npx` downloads the first time an agent that uses one runs. Their licences are listed in the Agent Client Protocol registry.
- **Other agents** such as Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, Goose and Qwen Code. Each is its vendor's own program, installed by you.

Whether a subscription may be used through another program is the vendor's rule. Read the terms of the vendor whose account you use.

## The Agent Client Protocol

Cubex speaks version 1 of the Agent Client Protocol (https://agentclientprotocol.com), an open protocol for talking to coding agents. The commands and download links of the agents it knows come from the protocol's public registry (https://github.com/agentclientprotocol/registry).
