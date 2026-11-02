# Changelog

Every version of Cubex is listed here, newest first. A version's section is also its release notes: the release page
opens with it, and so does the window that offers the update inside the app. It is written for the people who use
Cubex, not for the people who build it. Versions follow [Semantic Versioning](https://semver.org) as far as a 0.x
project can, and the format follows [Keep a Changelog](https://keepachangelog.com).

A version that is not released yet has the word Unreleased where its date goes. Releasing it means writing the date
there. [docs/RELEASING.md](docs/RELEASING.md) has the whole checklist.

## [0.3.0] - 2026-11-02

Cubex has a new look, and the agent can now keep working toward a goal on its own, a Stop hook can send it back to
work, and the agents it asks for a second opinion can be any agent that speaks the Agent Client Protocol. It can also
hand one of them a whole task, and Settings finds the agents installed on your PC and shows who is signed in to each.
Claude Code now works from the Claude desktop app with no command line install, and Antigravity works through
Google's agent runtime.

### New

- **A new look.** The window, the conversation and the panels now sit on three clearly different shades, replies are
  set larger than the work rows around them, and colour is kept for what it means: green and red for lines added and
  removed, and a small amber shield when Cubex needs you. A question from the agent now sits inside the message box,
  so nothing above it moves when it appears.
- **The run beside the conversation.** A column on the right lists the steps of the turn as they happen, the files it
  changed with a button that opens the review, and the commands left running in the background. Hide it with the
  button at its top. It steps aside in narrow windows, and the review opens in its place.
- **A status bar.** Along the bottom of the window: the branch, the model, the effort, how much of the context is in
  use, what you spent today, and whether Cubex is working or waiting for you.
- **A conversation that outgrows the model is rescued.** When the provider says a request is too long, Cubex trims old
  command output, summarizes the earlier messages and sends the request again, once.
- **The agent remembers what it was doing.** After earlier messages are summarized, the agent is reminded of its to-do
  list, its plan and the files it read and changed.
- **A model that repeats itself is stopped.** The third identical call in a row is answered with a note to change
  approach, and five identical calls with nothing changed in between end the turn with a message that says so.
  Running the tests again after an edit is never counted as a repeat.
- **More hooks.** Hooks can now run when a session starts, before and after earlier messages are summarized, when a
  subagent finishes and when Cubex is waiting for you. A hook on **When you send a message** can stop the message or
  add context for the model, and a hook on **Before a tool runs** can change what the tool is given. A changed tool
  call is checked and asked about again like any other.

- **Goals.** Type `/goal all tests pass --check npm test` and the agent starts working, then keeps going, one turn
  after another, until the goal is met. With `--check`, Cubex runs that command in the project after every turn, and
  the goal is met when it exits with 0, whatever the agent said. Without one, the agent has to say the goal is met and
  a model then reads what happened in the turn and decides. A bar above the composer shows where the goal stands, with
  **Pause**, a button that picks it up again and a button that clears it. `/goal pause`, `/goal resume` and
  `/goal clear` do the same. A goal stops when it is met, when the agent says it cannot go on without you, after 15
  turns (**Keep going** allows 15 more), when a spending cap is reached, and after two turns in a row that did no work
  and said nothing. **Stop** pauses it, and so does a turn that fails. A `/goal` that cannot run says why above the
  composer and keeps what you typed so you can correct it. In a new session it creates the task first. A goal is saved
  with its task and comes back paused, with a note, when Cubex is opened again. `--budget 200k` (also `200000` or
  `1.5m`) stops the goal once its turns have used that many input and output tokens, and the bar shows "38k of 200k
  tokens".
- **Stop hooks can keep the agent working.** A hook on **When a turn ends** that exits with code 2, or prints
  `{"decision":"block","reason":"..."}`, sends its reason to the agent, and the agent carries on instead of finishing.
  The hook is told when it has already done this in the same turn, so it can let go. After three requests the turn ends
  anyway. A hook that fails or takes longer than ten seconds counts as no objection. **Test** on the hook shows what it
  would do.
- **Any agent that speaks ACP.** Under **Other agents**, add Gemini CLI, Codex, GitHub Copilot, OpenCode, Cursor,
  Goose, Qwen Code or any other agent that speaks the Agent Client Protocol. Cubex keeps one session open with it
  between messages, so the agent remembers the talk, and closes it after ten quiet minutes. **Let it read this
  project** lets it read files in the open project. It is never allowed to change a file or run a command: Cubex
  answers its permission questions itself, and puts the agent in its most careful mode when it has one. **Test** starts
  the agent and shows what it said.
- **Agents found on your PC.** Under **Other agents**, **Found on this PC** lists Claude Code, Codex, Gemini CLI,
  OpenCode, Cursor, GitHub Copilot, Goose, Qwen Code and Antigravity, with the version of each one that is installed.
  For Claude Code and Codex it also shows who is signed in, such as "Signed in with ChatGPT". **Add** sets up the
  connection that fits what is installed, **Sign in** opens a terminal window that runs the agent's own sign-in, and
  **Check again** looks again. Each of these is the vendor's own program, so it uses the login it already has, such as
  a Claude or ChatGPT subscription, and needs no API key. Cubex never reads or copies that login, and it keeps keys
  and tokens out of the programs it starts.
- **The Claude desktop app.** When the Claude desktop app is installed, Cubex finds the copy of Claude Code that comes
  with it, so you need no command line install and no Node.js. The row says "Found in the Claude desktop app". Add
  it, and the model can ask it for an opinion or hand it a whole task. Cubex talks to Claude Code directly and holds
  it to your permission mode: Claude Code asks before every tool it uses, and Cubex answers by the same rules as for
  any other agent. Your own Claude Code settings are used for the sign-in and the model, the project's never are, and
  its hooks are off. If Claude Code is not signed in, **Sign in** runs `claude auth login` for that copy, and an API
  key named under **Variables to pass** works too.
- **Antigravity.** The Antigravity desktop app has nothing another program can talk to, so Cubex uses Google's
  separate agent runtime. In the Antigravity row, **Install the runtime** shows its size, downloads it from Google
  (about 125 MB on Windows), checks it against a fixed size and checksum before anything runs, and keeps it in Cubex's
  own data folder. **Sign in with Google** opens Google's sign-in page in your browser, and the runtime receives
  Google's answer by itself, so Cubex never sees the page or the token. Then **Add** makes it an agent like any other,
  for opinions and tasks. **Sign out** and **Remove** undo each step. Nothing of the Antigravity desktop app or of
  `~/.gemini` is used, and the runtime is Google's software under Google's terms. Part of the code that sets it up was
  ported from [T3 Code](https://github.com/pingdotgg/t3code), see `THIRD_PARTY_NOTICES.md`.
- **Hand a task to another agent.** Turn on **Let it take on tasks** for an ACP agent, and the model can hand it a
  whole task: implement something, research, review or run the tests. You read the whole task and approve it first.
  The agent works in the project, and each change it asks to make and each command it asks to run is answered by your
  permission mode, never outside the project. Ask before edits asks you, Accept edits allows an edit that is not in a
  protected folder, Plan mode allows only reading, and Bypass permissions allows what is inside the project. The
  thread shows a row for the task with the steps the agent took, the files it changed and its report. What it
  changed is kept in **Changes** and can be undone with **Rewind**. Cubex lists the project before and after, so a
  change the agent made without asking is shown too, and marked as not kept.
- **Test says what an agent can do.** **Test** on an agent that may take tasks says whether it has a mode in which it
  asks before it changes things. An agent that has none is given only tasks that read, such as research and review.
- **The PC stays awake.** While Cubex is generating a reply, checking a goal or running a background task, Windows does
  not put the PC to sleep, so a long run does not come back broken. The screen can still turn off. **Keep this PC awake
  while Cubex works** under **General** turns it off.

### Changed

- **Claude Code and Antigravity are added from Found on this PC.** That row sets up the connection that fits what is
  installed, and the choices under **Add an agent** are now an ACP agent, another program and a model. An agent you
  saved before with the command line connection keeps working. It can read the project but not take tasks, and
  removing it and adding it again from **Found on this PC** changes that.
- **The form for an ACP agent is shorter.** The program, its arguments, the variables to pass and the sign-in method
  are under **Program, variables and sign-in method**, which opens by itself when something there needs attention.
- **`/goal` does more.** In 0.2.0 it only added a note to the instructions the model reads. Now it starts a turn and
  runs the loop above.
- **Prices and limits are described correctly.** Cubex fills in a model's context size and price from the public
  models.dev list when the provider does not report them, which it has done since 0.1.0. It downloads that list when it
  lists your models, at most every six hours, with nothing about you in the request, and never in local-only mode. The
  README and the Local-only mode description under **Privacy** now say so.
- **Times read like a clock.** Durations show whole seconds, minutes and hours, such as 6s, 1m 12s or 2h 5m, and
  "Thinking" fades in and out while the model thinks.
- **Accent color** under **Appearance** now colours selected text only. Progress bars, sliders, links and the working
  star follow the theme.

### Fixed

- A goal stayed on "checking" for good when you opened another task while its check was running.
- When a delegated agent changed files in a build folder that git does not ignore, **Changes** did not show them.
- A model that wrapped its whole answer in an unfinished `<think>` tag showed an empty reply.
- A subagent's own steps were labelled with a stray prefix, and a skill's row said "Skill" twice.

### Good to know

- A goal's token budget counts what the provider reports. A provider that reports no token use, as some
  OpenAI-compatible services do, leaves the count at zero, so set a turn limit instead.
- Goals were tested with stand-in models and commands and with a real DeepSeek model on an OpenAI-compatible service. If a goal does
  something you did not expect, choose **Pause** or **Stop**, and [open an issue](https://github.com/HeshamXOR/Cubex/issues)
  with what you saw.
- A goal keeps going only while its task is the one on screen, and it waits, paused, when Cubex closes. A check command
  runs in the project folder, under your shell and your permissions, and is stopped after ten minutes, so use one you
  would run yourself.
- ACP agents were tested with a stand-in agent, except Claude Code, which was also tried against the real program with
  a stand-in for the model service. If one behaves differently on your PC, choose **Test** next to it in Settings,
  then open an issue with what it showed. Agents that run through `npx` download their adapter the first time, which
  takes a while and needs a network.
- Antigravity's runtime was tested in the packaged app with a stand-in that speaks its protocol, not with Google's
  runtime. Your first install and sign-in are that test. If the sign-in or a message fails, the row or the chat says
  why, and **Remove** followed by **Install the runtime** starts again.
- An ACP agent's sessions end when Cubex quits, and a message to one leaves this PC through that agent's own service.
  Local-only mode turns ACP agents off with the other programs.
- Tasks were tested with the same stand-in agents. The adapter for Codex has not been run against the real agent, so
  choose **Test** on yours first and read what it says about tasks.
- A task is handed over one at a time, and the model waits for its report for up to 30 minutes. The agent starts
  fresh for each task and does not see the conversation. What it uses is billed to its own account and does not
  count toward the spending limits in Cubex.
- A change an agent makes without asking, for example through a command, cannot be undone with **Rewind**. Cubex lists
  it and marks it as not kept. A command you allow runs with your permissions, and Cubex cannot limit what it touches.
- The **Sign in** window opens on Windows only. On other systems Cubex shows the command to run in a terminal.
- Whether a subscription may be used through another program is up to the vendor. Cubex starts only the program each
  vendor ships, and nothing else.

## [0.2.0] - 2026-10-08

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
