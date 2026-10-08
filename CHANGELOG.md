# Changelog

Every version of Cubex is listed here, newest first. A version's section is also its release notes: the release page
opens with it, and so does the window that offers the update inside the app. It is written for the people who use
Cubex, not for the people who build it. Versions follow [Semantic Versioning](https://semver.org) as far as a 0.x
project can, and the format follows [Keep a Changelog](https://keepachangelog.com).

A version that is not released yet has the word Unreleased where its date goes. Releasing it means writing the date
there. [docs/RELEASING.md](docs/RELEASING.md) has the whole checklist.

## [0.2.0] - Unreleased

Cubex now updates itself and shows what changed, the agent can ask other agents for a second opinion, and each part
of Settings has its own page.

### New

- **Updates inside the app.** Cubex looks for a newer release on GitHub shortly after it starts and then about every
  six hours, and whenever you choose **Check for updates** under **Updates** in Settings. When there is one, a card in
  the sidebar offers **What's new**, which opens the release notes. **Download update** fetches the installer and
  checks its size and SHA-256 checksum, and **Restart to update** runs it. If sessions or background tasks are still
  working, Cubex asks before it restarts. **Later** hides the card until something changes, **Skip this version**
  stays quiet about that version until a newer one comes, and a switch under Updates turns the automatic checks off.
- **Other agents.** In Settings, under **Other agents**, add Claude Code, Antigravity (`agy`), any command line
  program that reads a message and prints a reply, or a model from one of your providers. Test it there, then turn
  it on for a chat from the **+** menu in the composer. The model can send that agent a message, read the answer and
  answer back, for as many messages as the limit allows (three by default, one to six if you change it), until the two
  agree or the limit is reached. Cubex shows the whole message and asks before the first one to each agent in a
  reply. Every message and answer appears in the conversation, with who answered, which round it was and whether
  that agent agreed.
- **Settings has pages.** General, Appearance, Notifications, Models, Context and cost, Local models, Tools,
  Permissions, Other agents, Privacy, Updates and About are listed down the left side, and each page shows only its
  own settings. In a narrow window the list becomes a row along the top. The command palette finds a page by what is
  on it, so searching for "retry" or "agy" opens the right one.

### Changed

- **Switches and checkboxes are neutral.** They no longer use blue. On is filled and the knob sits at the right, off
  is an outline, so the state never depends on color alone. The blue accent is kept for text selection, links and
  progress.

### Fixed

- MCP servers are told which version of Cubex is running, where they were always told 0.1.0.

### Good to know

- Cubex 0.1.0 cannot update itself. Install this version once by hand, and later versions are offered inside the
  app. Only a copy set up by the installer can replace itself. An unpacked or portable copy gets a link to the
  release page instead.
- The installer is still not code-signed. Before it runs a download, Cubex checks the file against the SHA-256
  checksum that GitHub recorded for the release. That catches a damaged or swapped download. It does not protect
  against a release published by someone with access to this repository.
- An update check is one request to GitHub's releases API. It carries no account and nothing that identifies you,
  only the name and version of the app. Local-only mode blocks checks and downloads.
- Other agents were tested with stand-in programs, not yet with the real Claude Code and Antigravity. If one behaves
  differently on your PC, choose **Test** next to it in Settings, then [open an issue](https://github.com/HeshamXOR/Cubex/issues)
  with what it showed.
- A program agent runs in an empty folder, so it sees only the message. Claude Code can be allowed to read the open
  project, never to change it. A message to an agent leaves this PC through that agent's own service, so do not send
  it anything you would not send there. Local-only mode turns programs off.

## [0.1.0] - 2026-10-07

The first public release of Cubex, a desktop coding agent that works with any model.

- **Any model.** 17 provider presets, from OpenAI, Anthropic and Google Gemini to Ollama, LM Studio, llama.cpp, any
  OpenAI-compatible endpoint and an offline demo. The effort control shows what the selected model supports.
- **Review before anything is kept.** Every edit is a diff. Keep or undo it by file or by hunk, comment on a line and
  send the comments back, or restore the project to an earlier message. Commit from the panel. Cubex never pushes.
- **You set the limits.** Ask before edits, Accept edits, Plan mode and Bypass permissions, rules you save per project,
  and hooks. Plan mode produces a plan you approve before any file changes.
- **Work that keeps running.** Dev servers, watchers and long builds run in the background, with a Tasks tab to follow
  and stop them.
- **Context and cost.** A context inspector, summarizing that keeps the full history, and spending caps per turn,
  session and day.
- **Local models.** A hardware check that says which models your PC can run, Ollama downloads, and a local-only mode.
- **Extensible.** MCP servers over stdio, hooks, 18 bundled skills, and project instructions from `AGENTS.md` or
  `CLAUDE.md`.
