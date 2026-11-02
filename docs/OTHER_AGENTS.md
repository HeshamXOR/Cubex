# Other agents

The agent in a chat can ask another agent for a second opinion and talk a question through with it until the two agree, or until a limit you set is reached. It can also hand another agent a whole task, such as fixing a bug or writing tests, and read the report when the agent is done. The other agent can be Claude Code, from its command line or from the Claude desktop app, Antigravity, through Google's agent runtime, an agent that speaks the Agent Client Protocol (ACP), any command line program that reads a message and prints a reply, or a model from one of your providers. Cubex finds the agents that are installed on this PC and shows who is signed in to each. An agent uses the sign-in it already has, such as a Claude or ChatGPT subscription, so it needs no API key. Antigravity is the exception: Cubex installs Google's runtime when you ask, and you sign in to it once with your Google account. This page covers how to set one up, what happens in a chat, what each kind of agent can see and do, and what leaves your PC. The code is in `src/main/peers` and `src/shared/peers.ts`. "Peer" is the name in code, and the interface says "other agents".

## Setting one up

1. Open **Settings**, then **Other agents**. Under **Found on this PC**, Cubex lists the coding agents it knows, with the version and the account of each one that is installed (see [Found on this PC](#found-on-this-pc)). Choose **Add** next to one: the form opens with the connection filled in, and **Add agent** saves it. Claude Code and Antigravity have sections of their own, see [Claude Code and the Claude desktop app](#claude-code-and-the-claude-desktop-app) and [Antigravity](#antigravity). Under **Add an agent**, choose what else to add:
   - **An ACP agent** is an agent that speaks the Agent Client Protocol: Gemini CLI, Codex, GitHub Copilot, OpenCode, Cursor, Goose, Qwen Code, or any other program that does. Cubex fills in the command and the arguments that make it speak the protocol, and you can change both. **Let it read this project** lets it read files in the open project. It is never allowed to change a file or run a command when it is only asked for an opinion. **Let it take on tasks** lets the model hand it whole tasks. See [ACP agents](#acp-agents) and [Handing over a task](#handing-over-a-task).
   - **Another program** runs any command that reads a message and prints a reply. You give it the arguments that come before the message, and say whether the message goes to standard input or is added as the last argument. Use it for a program that does not speak ACP.
   - **A model** is a model of one of your providers, asked a plain question.

   An agent saved before this version with the command line connection, Claude Code as `claude -p` or Antigravity as `agy -p`, keeps working. It can read the project but cannot take tasks. To change that, remove it and add the agent again from **Found on this PC**.
2. Choose **Test**. It sends the message "Reply with the single word OK." the way a chat would and shows what came back, how long it took and, when it failed, why and what to do about it. A test of an ACP agent starts it, asks the question and stops it again. When the agent may take tasks, the test also says whether it can take tasks that change the project (see [What a test says about tasks](#what-a-test-says-about-tasks)). The first test of an agent that runs through `npx` downloads its adapter, so it is allowed four minutes. Other tests are allowed two minutes.
3. In a chat, open the **+** menu in the composer and turn the agent on under **Other agents**. Each chat keeps its own choice.

The list holds up to eight agents. **Most messages to one agent per reply** is a number from one to six, three by default. It limits a back and forth for an opinion and does not apply to tasks. Settings shows whether each program was found on this PC, and **An ACP agent** says how many of the ones it knows are. The form for a new ACP agent opens on the first of them that is installed here. The form shows the name, the agent and the two switches. The program, its arguments, the variables to pass and the sign-in method are under **Program, variables and sign-in method**, which opens by itself when something there needs attention.

## Found on this PC

Under **Found on this PC**, Cubex lists the coding agents it knows by name: Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, Goose, Qwen Code and Antigravity. Cubex looks for each program the way a terminal would: on `PATH`, on the `PATH` the Windows registry holds now (a program installed since Cubex started is there), and in the folders installers usually use, such as the npm folder and `~\.local\bin`. For Claude Code it also looks in the Claude desktop app, which brings its own copy, and the row then says "Found in the Claude desktop app". It never looks in the project folder.

For each program it finds, Cubex starts it with `--version` and shows the result. For Claude Code it also runs `claude auth status`, and for Codex `codex login status`, and shows who is signed in: for example "Signed in with Claude Max (name@example.com)", "Signed in with ChatGPT" or "Not signed in". The other agents have no command that Cubex knows to print this, so their row says "Sign-in not checked" and tells you what to do first. These are the only things Cubex asks the programs. It reads what the program prints, never the saved login.

- The programs run in the system's temporary folder, without a shell, with the same cleaned environment as every program Cubex starts. A version check is stopped after six seconds, and an account check after fifteen. At most four run at once.
- The answer is kept for two minutes. **Check again** looks again, and so does coming back to the window after you used **Sign in**.
- **Sign in** appears next to an agent that is not known to be signed in and has a sign-in command its vendor documents (`claude auth login`, `codex login`, `opencode auth login`, `cursor-agent login`). It opens a terminal window that runs that command, so the program itself opens the browser and asks what it asks. For Claude Code from the Claude desktop app, the window runs that copy. Cubex does not see what is typed in that window and does not read the login afterwards. The window opens on Windows only. Elsewhere the row tells you the command to type. Antigravity has its own sign-in, see [Antigravity](#antigravity).
- **Add** sets up the connection that fits what is installed. For Claude Code that is a direct connection to Claude Code itself, which needs no Node.js. For Codex it is the ACP adapter, which runs through `npx`, so **Add** waits until Node.js is installed and says so. Antigravity is set up in steps first.
- **Get** opens the agent's own page in your browser when it is not installed. Cubex does not install any of these programs, with one exception: Google's Antigravity runtime, which Cubex installs when you ask.
- In local-only mode Cubex looks for the programs without starting them, so versions and accounts are not shown.

## Claude Code and the Claude desktop app

The Claude desktop app comes with its own copy of Claude Code, so a PC that has the app needs no command line install and no Node.js. Cubex starts the copy on `PATH` or, when there is none, the one the desktop app keeps, and talks to it directly. There is no adapter from npm in between.

**Where Cubex looks.** On `PATH` first, as for every program. Then in the folders the desktop app keeps its copy in, one folder for each version it has installed:

| System | Folders |
|---|---|
| Windows | `%APPDATA%\Claude\claude-code` and `%LOCALAPPDATA%\Claude\claude-code`, and the same two under `Claude-3p` |
| macOS | `~/Library/Application Support/Claude/claude-code`, and the same under `Claude-3p` |
| Linux | `$XDG_CONFIG_HOME/Claude/claude-code`, or `~/.config/Claude/claude-code`, and the same under `Claude-3p` |

`Claude-3p` is the folder name of another build of the desktop app. In each version's folder Cubex takes `claude.exe` (`claude` outside Windows), directly in it or one folder down, which is where the other build keeps it. The newest version wins, and between equal versions the standard app does. Cubex reads only folder and file names there, and never opens a file the app keeps for itself, because that is where its login is. The path is not saved: the app updates itself and the folder of one version goes away with it, so Cubex looks again each time.

**How it is started.** In Claude Code's own `stream-json` mode, in an empty folder or the project, with these rules:

- `--permission-prompt-tool stdio` makes Claude Code ask Cubex before it uses a tool. The same policy answers as for every other agent: for an opinion it allows reading inside the folder and nothing else, and for a task it follows your permission mode, see [What a task may do](#what-a-task-may-do). The answer is always "this once". A tool that changes something and runs without asking ends the turn and the program.
- `--tools` is the list of tools it has at all. For an opinion that is `Read`, `Grep`, `Glob` and `LS`. For a task it adds `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `PowerShell`, `WebFetch`, `WebSearch` and `TodoWrite`. Tools that start other agents, schedule work or change the folder do not exist for it.
- `--setting-sources user` loads your own Claude Code settings, for the sign-in and the model, and never the project's, because a project can carry hooks that run a command. `--settings` adds a file of Cubex's that wins over them: every tool that reads, changes or reaches out is "ask", hooks are off, the mode that never asks cannot be entered, and commits and pull requests get no "co-authored by Claude" line.
- `--strict-mcp-config` and `--no-session-persistence`: none of your MCP servers, and nothing saved to disk. `--model` is passed when the agent's arguments name a model.
- Its environment is the one every program gets, with anything that looks like a key or token removed, without the variables that say it is inside another Claude Code, with `DISABLE_AUTOUPDATER=1`, so that the copy of an app that updates itself is not replaced while it runs, and `CLAUDE_CODE_ENTRYPOINT=cubex`.

**Signing in.** Cubex asks `claude auth status` who is signed in and shows it. If Claude Code is not signed in, the row says "Not signed in" and **Sign in** opens a terminal that runs `claude auth login` with the copy it found. Another way is an API key: add `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` if you use a gateway, under **Variables to pass**. A chat that asks an agent that is not signed in gets a message that says so and how to fix it.

It was tried against the real program, with a stand-in for the model service, in versions 2.1.181 and 2.1.293. No real account was used.

## Antigravity

Antigravity comes in three forms. The **desktop app** has no interface that another program can use, so Cubex does not start it or read its files. The **`agy` command line** is an older way in that still works for an agent saved with it, for opinions only. Cubex's own way in is Google's **agent runtime**, `agy_acp_server`, which speaks the Agent Client Protocol and does what the other ACP agents do: opinions, tasks and permission questions. Because it is a separate download with a sign-in of its own, **Found on this PC** walks through it in order: install, sign in, add.

1. **Install the runtime.** The row says how much it downloads from Google and how much disk it takes before you choose, about 125 MB and 227 MB for Windows on x64. Cubex downloads Google's own archive from Google's own host and accepts it only if it is exactly the release Cubex pins: the size and the SHA-256 of the archive match, the archive holds exactly the two programs with the sizes pinned, and the program starts and says it is that release. Only then does Cubex switch to it, so an install that fails or is cancelled at any step leaves what was there as it was. **Cancel** stops the download. When Cubex pins a newer release than the one on disk, the row offers **Update**. Google's terms apply to the runtime (https://antigravity.google/terms), and Cubex never redistributes it.
2. **Sign in with Google.** Cubex starts the runtime, the runtime reports the address of Google's sign-in page, and Cubex opens it in your default browser. Only a page of Google's is opened: the address has to be `https://accounts.google.com/o/oauth2/v2/auth` and send the answer back to this PC (`http://127.0.0.1` and a port). Anything else is refused, nothing is opened, and the row says so. The runtime waits on this PC for Google's answer, so Cubex never sees the page, the code or the token, and never opens the file where the runtime saves the sign-in. It only checks that the file is there. You have five minutes. **Open Google's page again** and **Cancel** are in the row while it waits. Google can require an eligible subscription for the account, and the row says so when it does.
3. **Add.** Once the runtime is installed and signed in, **Add** opens the form with Antigravity filled in. It works like any other ACP agent, with **Let it read this project** and **Let it take on tasks**.

**Sign out** asks the runtime to forget the sign-in. **Remove** deletes the runtime and its sign-in. Both first stop the Antigravity sessions that chats keep open between messages. **Remove** refuses while a sign-in is going, while the runtime is being installed and while a task is still running, and the message says to finish, cancel, stop the task or wait.

**A private profile.** The runtime runs with a profile of its own in Cubex's data folder (its `GEMINI_HOME`), and a temporary folder for each run. It does not use `~/.gemini`, the data of the Antigravity desktop app or any other Google login. The variables that would point it at another login are removed from its environment: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, the Google Cloud project settings, `GEMINI_HOME`, `BROWSER` and the like. `BROWSER` is set by Cubex to a small helper that reports the sign-in address to Cubex instead of opening anything.

**In a chat.** The runtime is never allowed to ask you to sign in from inside a chat. If it is not signed in, the message fails with "Antigravity is not signed in." and says to use **Sign in with Google** in Settings. The runtime sends questions for you in the place of permission requests. Cubex answers those with "cancelled": a question is not a permission, and picking one of its answers would be speaking for you. Real permission requests go through the policy described under [What a task may do](#what-a-task-may-do). The runtime's tool calls are put in the shape the rest of Cubex reads, and very large results are bounded.

**Local-only mode** blocks the download, the sign-in, the sign-out and starting the runtime, and the row says so.

The runtime was tried in the packaged app with a stand-in that speaks its protocol, including the install, the sign-in, a page that is not Google's, a sign-in that ends in the middle of an answer, tasks that were allowed and denied, sign-out and removal. It has not been run against Google's real runtime yet, because that means a download and a Google sign-in. The first install and sign-in on your PC are that test. If something differs, **Test** shows what the runtime printed.

## Using your own subscription

Every agent in the list is the vendor's own program, and the account it is signed in with stays where that program keeps it. Cubex starts the program and the program uses its saved login, so a Claude or ChatGPT subscription is used by Claude Code or Codex itself and no key is copied or needed. Cubex asks the program who is signed in and reports it, and that is all it does with an account.

To make sure of that, Cubex keeps anything that looks like a key or token out of the environment of every program it starts: `CUBEX_*`, `ANTHROPIC_*`, `OPENAI_*` and any name ending in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PAT` or `_CREDENTIAL`. An agent that signed in once in a terminal keeps using that sign-in. An agent that reads a key from its environment gets it only when you name the variable under **Variables to pass**.

What a subscription allows, and whether it can be used through another program, is up to the vendor, and the terms differ and change. Cubex starts only the program each vendor ships, the way it is meant to be started. If you are unsure, read the vendor's terms.

## What happens in a chat

When an agent is on, the model has a tool called `consult_agent`. The model uses it when you ask it to consult or agree with that agent, or when a second opinion would help. It does not use it for routine steps. An agent that may take tasks also gives the model `delegate_task`, see [Handing over a task](#handing-over-a-task).

1. Cubex shows you the whole message and which agent it is going to, and asks. This happens before the first message to each agent in a reply. **Bypass permissions** mode approves it without asking. A saved "Always allow" rule never covers it, because the message leaves for another program or service.
2. The agent is told it is being consulted, to give its own view with reasons, to change nothing, and to end with one line, `Verdict: agree`, `Verdict: partly agree` or `Verdict: disagree`.
3. The reply goes back to the model, wrapped as another agent's opinion and not as an instruction from you. The model reads it, answers the strongest point and may send another message, until the two agree or the limit is reached. A message that fails does not count as a round, and after two failures with the same agent in a reply the model stops asking it.
4. The model tells you what was agreed, what is still open and the strongest argument on each side. It does not change files because of a disagreement without asking.

The conversation shows a row for each message, named for the agent ("Ask Claude Code"), with the round, how long it took and the verdict as **Agrees**, **Partly agrees** or **Disagrees**. Open the row to read what was sent and what came back. The rows are kept in saved history.

A program answers one message and exits, and a model is asked one request at a time, so neither shares a session with the chat. Each message has to carry what the agent needs. Cubex keeps what was said to each agent in the chat and sends the last six exchanges (40,000 characters at most, dropping the oldest first) along with each new message, so a later message continues the talk. An ACP agent is different: Cubex keeps its session open, so the agent already remembers the talk, and the record is sent only when a session has to be started again. That record is kept in memory only. It is gone when Cubex restarts or the chat is deleted.

## Handing over a task

An ACP agent with **Let it take on tasks** on gives the model a second tool, `delegate_task`. The model uses it for self-contained work: a feature, a refactor, a bug hunt, running the tests or a review. It does small edits and quick questions itself. The tool needs an open project, because the agent works in it.

1. The model writes the task, so that someone who has seen none of the conversation can do it, and chooses the agent and what the task is for: **Implement** (the default), **Research**, **Review** or **Run tests**. Research and review only read.
2. Cubex shows you the whole task, the agent and the command that will be started, and asks. **Bypass permissions** mode approves it without asking. **Accept edits** still asks, and a saved "Always allow" rule never covers a task. In **Plan mode** a research or review task is asked about as usual, and a task that would change anything is refused.
3. Cubex starts a fresh copy of the agent in the project folder, gives it the task and the instruction to finish with a short report, and waits. It offers the agent no file access and no terminal of its own, so the agent works with its own tools.
4. Whenever one of those tools needs permission, the agent asks Cubex, and your permission mode answers as it does for Cubex's own tools, see [What a task may do](#what-a-task-may-do). What needs your answer appears in the thread as a card, with the change shown as a diff or the command in full, and **Allow once** or **Deny**. Questions come one at a time.
5. The agent reports, and the task ends. The report goes back to the model, wrapped as another agent's account and not as an instruction. The model is told that it may be wrong and that it has to read what changed and run the checks before it tells you the work is done.

The thread shows one row for the task, named for the agent ("Delegate to Codex"), with the role, the time and the state: **Working**, **Waiting for you**, **Done**, **Failed** or **Cancelled**. Open the row to read the task, the steps the agent took as it reported them, the files that changed and the report. The row is kept in saved history. **Stop** on the turn cancels the task: Cubex asks the agent to cancel, stops it if it has not finished after five seconds, and the files it changed before that are still listed.

### What a task may do

The agent has no more room than the chat has. The answer to each request depends on the permission mode of the chat at that moment, and a mode that changes during a task applies from then on.

| What the agent asks to do | Ask before edits | Accept edits | Plan mode | Bypass permissions |
|---|---|---|---|---|
| Read, search or think inside the project | Allowed | Allowed | Allowed | Allowed |
| Edit a file inside the project | Asks you | Allowed, unless the file is in a protected folder, which asks | Refused | Allowed |
| Delete or move a file inside the project | Asks you | Asks you | Refused | Allowed |
| Run a command | Asks you, unless it only looks, such as `git status` | Asks you, unless it only looks | Refused | Allowed |
| Fetch a page | Asks you | Asks you | Refused | Allowed |
| A kind of request Cubex does not recognise | Asks you | Asks you | Refused | Allowed |

- A request to read a file outside the project is refused, and so is a request to edit, delete or move one, in every mode. A request that does not say which file it is about is never allowed without asking, because Cubex cannot check where it lands.
- A request to change the agent's own mode is refused in every mode.
- A research or review task may read, and may fetch a page when you allow it. Everything else it asks for is refused, in every mode, and Plan mode refuses the fetch too.
- The answer is always "this once", never "always", because an "always" would be written into the agent's own settings, which are yours.
- Protected folders are the ones the file tools protect: `.git`, `.cubex`, `.claude`, `.agents`, `.codex`, `.vscode` and `.husky`.

A command that you allow runs with your permissions. Cubex cannot limit what it touches, and the question says so.

### What Cubex does with the changes

Cubex lists the project folder before the task starts and again when it ends (up to 20,000 files, and four seconds). Every file that differs is listed under **Files changed** as edited, created or deleted. A change the agent asked about is kept as it was before, so it shows in **Changes** and **Rewind** can undo it. A change made without asking, for example by a command, is marked **not kept**: Cubex saved no copy, so Rewind cannot undo it, and the row says so. When the project is too large to list in full, the report says that a change made without asking may be missing.

### What a test says about tasks

An agent has modes that decide how much it does without asking, and Cubex holds an agent to your permission mode by putting it in a mode that asks before it changes things. **Test** on an agent that may take tasks says which kind it is:

- "Can take any kind of task. It works in its "Default" mode, which asks before it changes things."
- "Can take any kind of task. It offers no modes, so Cubex judges it by the questions it asks." Cubex then relies on the questions the agent sends.
- "Can take research and review tasks, but not tasks that change the project: it has no mode in which it asks before it changes things." The modes it offers are listed. Such an agent cannot be held to your permission mode, so it is given only tasks that read, and a task that would change something fails with that reason.

### Limits

- A task is at most 24,000 characters. An agent has two minutes to start, which covers signing in and choosing its mode, and 30 minutes to finish a task, and is stopped with everything it started when the time is up.
- The model waits for the report. One task runs at a time in a turn, and each task starts a fresh agent, so the agent does not remember an earlier task.
- At most 60 steps and 200 files are shown. A report is cut at 12,000 characters.
- What the agent uses is billed by its own service, to its own account, so it does not count toward the spending limits in Cubex.
- Local-only mode turns agents that are programs off, tasks included.

## ACP agents

The Agent Client Protocol (ACP) is a standard way for a program to act as an agent that another program, here Cubex, can talk to over its standard input and output. Cubex starts the program, opens a session in it, sends the message and collects the reply as it streams in. Because the program keeps running between messages, an ACP agent remembers the talk, and Cubex can answer the questions it asks about what it may do.

| Agent | What Cubex runs | Notes |
|---|---|---|
| Claude Code | `claude`, in its own `stream-json` mode behind a bridge | From the command line or the Claude desktop app, with no Node.js and no adapter. It uses the sign-in Claude Code already has. See [Claude Code and the Claude desktop app](#claude-code-and-the-claude-desktop-app). |
| Claude Code (adapter) | `npx --yes @agentclientprotocol/claude-agent-acp@0.89.0` | An older way in, kept for agents saved with it. The adapter is downloaded from npm the first time, so Node.js has to be installed. |
| Codex | `npx --yes @agentclientprotocol/codex-acp@2.1.1` | The adapter is downloaded from npm the first time, so Node.js has to be installed. |
| Gemini CLI | `gemini --acp` | |
| GitHub Copilot | `copilot --acp` | |
| OpenCode | `opencode acp` | Uses the providers set up in OpenCode. |
| Cursor | `cursor-agent acp` | |
| Goose | `goose acp` | |
| Qwen Code | `qwen --acp` | |
| Antigravity | `agy_acp_server`, the runtime Cubex installs from Google | Its own Google sign-in, set up under **Found on this PC**. See [Antigravity](#antigravity). |
| Another ACP agent | The command and arguments you enter | See [Adding your own ACP agent](#adding-your-own-acp-agent). |

The commands are the ones the ACP registry at agentclientprotocol.com lists for each agent. They are shown on the form and you can change them, for example to use the full path of a program that is not on `PATH`. The adapters are pinned to one version, so a newer release of one never runs until a version of Cubex that names it is installed. Cubex does not install any of these programs, except the Antigravity runtime when you ask. Settings says whether each one is found on this PC.

**Signing in.** Cubex never asks for a password and never reads a login. An agent that is signed in on this PC, because you started it once in a terminal or used **Sign in** under **Found on this PC**, uses what it saved. An agent that reads a key from its environment, such as `GEMINI_API_KEY` or `OPENAI_API_KEY`, gets it when you name the variable under **Variables to pass**, because Cubex keeps anything that looks like a key or token out of the programs it starts. When an agent asks to be signed in over the protocol, Cubex asks it to use the one method it can carry out by itself. If it offers several, the message fails with the list, and you enter the one to use under **Sign-in method**. If it offers none, start the program once in a terminal and sign in there.

**Sessions.** Each chat has one session per agent for opinions. The first message starts it, and the next ones go to the same session, so a follow-up costs no start and the agent still has the talk. A session answers one message at a time. It stops when the chat has not used it for ten minutes, when the chat is deleted, when you change that agent's settings, when a message to it fails, is cancelled or times out, and when Cubex quits. At most four run at once, and starting another stops the one that has been quiet longest. The next message starts a fresh session and carries what was said so far. A task never uses one of these sessions: it has a copy of its own, which ends with the task.

## What each agent can see

| Agent | Where it runs | What it sees |
|---|---|---|
| A model | Its provider, through the same gateway as chat, and billed and counted like any request | The protocol, the earlier messages with it, and the new message. No tools and no files. |
| A program | On this PC, in an empty folder that Cubex creates and deletes afterwards | Only the message. |
| Claude Code with **Let it read this project** on | On this PC, in the project folder | The message and the files in the project, through read, search and glob tools only. |
| An ACP agent | On this PC, in an empty folder that Cubex creates and deletes afterwards | Only the message. |
| An ACP agent with **Let it read this project** on | On this PC, in the project folder | The message and the files in the project, through its own read and search tools. |
| An ACP agent given a task | On this PC, in the project folder | The task and the project. It reads with its own tools and asks to change files and run commands, and Cubex answers as described under [What a task may do](#what-a-task-may-do). It does not see the conversation. |

A program is started without a shell, with Cubex's own credentials kept out of its environment (the same cleaning as for hooks and MCP servers, see [SECURITY.md](SECURITY.md)). A variable it needs, such as an API key, is named under **Variables to pass**, and only those are handed on. A program that is not signed in has to be signed in first: use **Sign in** under **Found on this PC**, or start it once in a terminal and follow its login steps.

The command line connections, which agents saved before this version may still use, start Claude Code with `-p`, JSON output, **no tools** (or `Read,Grep,Glob` when it may read the project), only your user settings and not the project's, no MCP servers, nothing saved to disk, and a limit of 3 turns (12 with the project). It never gets `--dangerously-skip-permissions`, so a tool that would need permission is refused. Antigravity's command line is started as `agy --output-format json -p "<message>"`. Both were written from the vendors' documentation and tested with stand-in programs. If either behaves differently on your PC, **Test** shows what it printed.

### What an ACP agent may do when it is asked for an opinion

Cubex offers an ACP agent no file access and no terminal of its own, and none of your MCP servers. The agent does what it does with its own tools, and when one of them needs permission it asks Cubex, which answers by one rule. Reading, searching and thinking are allowed, but only inside the folder the agent was started in, with links followed, so a path that leads out of it is refused. Everything else is refused: editing, deleting, moving, running a command, fetching a page, changing the mode, and anything Cubex does not recognise. The answer is always "this once", never "always", because an "always" would be written into the agent's own settings, which are yours.

Agents have modes that decide how much they do without asking. Cubex reads the modes an agent offers and moves it into the most careful one: read-only, then plan, then a mode that asks. A mode whose meaning Cubex cannot tell is never chosen, and neither is one such as bypass, yolo or auto. An agent that is in a mode that acts without asking, with no careful one to move to, is refused, and the message says so. If an agent moves itself into such a mode during a talk, its reply is thrown away and the message fails. For a task that changes things, Cubex chooses a mode that asks before it changes things, then a read-only one, and refuses the task when the agent offers modes and none of them asks.

This is a rule for what an agent asks about. Cubex cannot stop an agent from doing something it never asks about, and an agent that has no modes cannot be checked at all, which is why a task lists what changed in the project afterwards. An ACP agent is a program that runs with your permissions, so add only the ones you would run yourself.

## What leaves your PC

A message to a program goes to that program, and most of them send it to their own cloud service under their own terms. A task goes the same way, and the agent reads the project to do it, so what it reads can go to its service too. A message to a model goes to that model's provider. The first message to an agent that runs through `npx` also downloads its adapter from the npm registry. All of these can contain your code, because the model puts into the message what the agent needs to see. Read the message in the approval card before you allow it.

Looking for agents under **Found on this PC** sends nothing anywhere: the programs are started with `--version` and an account command, and what they print is read on this PC. A program may contact its own service to answer, as it does when you run it yourself. Claude Code, started from the command line or the Claude desktop app, sends the message and what it reads to Anthropic, as it does when you run it yourself.

Antigravity adds three things that leave the PC, each only when you ask. **Install the runtime** downloads about 125 MB from Google's host, `dl.google.com`. **Sign in with Google** opens Google's own sign-in page in your browser, and the sign-in is saved by the runtime in Cubex's data folder. A message to the runtime goes to Google's service, with what it reads of the project to do a task.

**Local-only mode** turns programs off, ACP agents and tasks included, because nearly all of them reach a cloud service. A model agent follows the rule for providers: it works only if its provider is local. Neither is a network firewall, see [SECURITY.md](SECURITY.md#privacy).

## Limits and what Cubex does with output

- A message is at most 24,000 characters. A program that takes the message as an argument is limited by the command line (about 28,000 characters on Windows), and a program that reads standard input by 120,000.
- A program has ten minutes to answer, and is stopped with everything it started when the time is up or you stop the turn.
- An ACP agent has two minutes to start, which covers signing in and choosing its mode, and ten minutes to answer a message. When you stop the turn, Cubex asks the agent to cancel, and stops it if it has not finished after five seconds. At most 400,000 characters of a reply are kept, and a reply longer than 24,000 is shortened for the model and says so, like any other agent's. Anything an agent prints that is not a protocol message is dropped.
- Cubex speaks version 1 of the protocol. An agent that speaks another version is refused, and the message says which.
- Output is bounded (400,000 characters of standard output, the last 8,000 of error output), stripped of colour codes, scrubbed of anything shaped like a key, and read as data. A reply longer than 24,000 characters is shortened and says so. An agent cannot close the wrapper it is returned in.
- Programs that install as a Windows batch file (`.cmd`) cannot take a message that contains quotes, percent signs or line breaks as an argument, because `cmd.exe` would reinterpret them. Cubex says so and suggests an `.exe` or standard input.
- Antigravity before version 1.1.1 prints nothing on Windows when it is started without a terminal. Update it with `agy update`.
- Tasks are handed over one at a time and the model waits for each, so a task that takes the full 30 minutes holds the turn. A task through Claude Code was tried against the real Claude Code with a stand-in for the model service. A task through the Codex adapter, and anything through the Antigravity runtime, was tried with stand-in agents only, so choose **Test** on your own agent first and read what it says about tasks.

## Adding your own program

Choose **Another program** and enter the command, its arguments and where the message goes. A command that reads a prompt from standard input and prints the answer works with the defaults, for example:

| Program | Command | Arguments | Message |
|---|---|---|---|
| Codex | `codex` | `exec` `-` | standard input |
| A script | `node` | `reviewer.mjs` | standard input |

The arguments above are examples, so check how your program reads a prompt. Then **Test** it. A program that prints something other than the reply (progress lines, a banner) is read as plain text, so keep its output to the answer. The program runs in an empty folder, so a relative path in its arguments will not find your project. A program cannot take tasks, because it does not ask Cubex what it may do. Use an ACP agent for that.

## Adding your own ACP agent

Choose **An ACP agent**, then **Another ACP agent**, and enter the command and the arguments that make the program speak the protocol on its standard input and output. The agents above show what that looks like: `--acp` for some, a word such as `acp` for others, and the registry at agentclientprotocol.com lists the command of each agent it knows. Then **Test** it. A program that does not speak ACP fails the test, and the test shows what it printed.

## Where the code is

| What | Where |
|---|---|
| The settings, the presets, the checks | `src/shared/peers.ts` |
| The agents Cubex knows by name, and how an account is described | `src/shared/agentCatalog.ts` |
| The `consult_agent` tool, its approval text and the row it leaves in the conversation | `src/main/peers/consultTool.ts`, `src/renderer/src/components/ToolCard.tsx` |
| The `delegate_task` tool and its approval text | `src/main/peers/delegateTool.ts` |
| One task, from start to report, and what changed | `src/main/peers/delegate.ts`, `src/main/peers/manifest.ts` |
| What an agent is told | `src/main/peers/framing.ts` |
| Starting a program, finding it, stopping it | `src/main/peers/peerRunner.ts` |
| Where a program is looked for, and the environment it gets | `src/main/peers/environment.ts` |
| Looking for the agents on this PC, versions and accounts | `src/main/peers/detect.ts` |
| The terminal window of **Sign in** | `src/main/peers/signIn.ts` |
| The protocol over a program's standard input and output | `src/main/peers/acp/connection.ts` |
| Starting an ACP agent, signing in, one message at a time | `src/main/peers/acp/agent.ts` |
| What an ACP agent is allowed to do when asked for an opinion | `src/main/peers/acp/permissions.ts` |
| What an agent is allowed to do in a task | `src/main/peers/acp/delegatePolicy.ts` |
| Choosing a mode, and whether an agent can take a task | `src/main/peers/acp/modes.ts` |
| Sessions kept between messages | `src/main/peers/acp/sessions.ts` |
| A stand-in ACP agent for the tests | `src/main/peers/acp/testing/mockAgent.cjs` |
| How an agent's process is started, by preset | `src/main/peers/acp/starters.ts` |
| Where the Claude desktop app and the Antigravity desktop app keep their programs | `src/main/peers/appPrograms.ts` |
| Claude Code behind a bridge: how it is started, what its tools are, and how its questions become permission requests | `src/main/peers/claude/launch.ts`, `src/main/peers/claude/start.ts`, `src/main/peers/claude/tools.ts`, `src/main/peers/claude/bridge.ts` |
| Stand-ins for Claude Code and for the model service behind it | `src/main/peers/claude/testing/mockClaude.cjs`, `src/main/peers/claude/testing/anthropicMock.ts` |
| Antigravity: the pinned release, the install and the archive reader | `src/main/peers/antigravity/release.ts`, `src/main/peers/antigravity/install.ts`, `src/main/peers/antigravity/zip.ts` |
| Antigravity: the private profile, the environment, starting the runtime, signing in and out | `src/main/peers/antigravity/profile.ts`, `src/main/peers/antigravity/runtime.ts`, `src/main/peers/antigravity/signin.ts` |
| Antigravity: the filter between Cubex and the runtime, and the shape of its tool calls | `src/main/peers/antigravity/filter.ts`, `src/main/peers/antigravity/wire.ts` |
| A stand-in for Google's runtime | `src/main/peers/antigravity/testing/mockAgy.cjs` |
| What Settings is told about Antigravity, and its handlers | `src/shared/antigravity.ts`, `src/main/peers/antigravity/status.ts`, `src/main/ipcModules/antigravity.ts` |
| The Antigravity row and its wording | `src/renderer/src/lib/antigravityRows.ts`, `src/renderer/src/lib/useAntigravity.ts` |
| Reading what it printed, and the verdict | `src/main/peers/output.ts` |
| What was said to each agent in a chat | `src/main/peers/transcript.ts` |
| Asking a model, approving, the round count per reply, the questions of a task | `src/main/ChatService.ts` |
| Test, status, detection and sign-in handlers | `src/main/ipcModules/peers.ts` |
| The Settings page and the composer menu | `src/renderer/src/views/settings/sections/AgentsSection.tsx`, `src/renderer/src/views/settings/FoundAgents.tsx`, `src/renderer/src/views/settings/AgentEditor.tsx`, `src/renderer/src/components/chat/Composer.tsx` |
| The task row in the thread and the question cards | `src/renderer/src/components/DelegatePanel.tsx`, `src/renderer/src/components/chat/PermissionCard.tsx` |
