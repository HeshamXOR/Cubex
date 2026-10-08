# Agent workflow and tools

This guide describes how Cubex works through a task: what the model may do on its own, what it must ask about, how a plan is reviewed, which tools exist and where their limits are, and how you review and undo what a task changed. Limits quoted here are the values in the code today.

A turn is one message from you and everything the model does in response. The model can make up to 50 requests in a turn, with tool calls between them. If it reaches that cap, Cubex says so in the reply and you can answer "continue".

## Permission modes

The mode pill in the composer sets what Cubex may do without asking. **Shift+Tab** cycles through the modes.

| Mode | What happens |
|---|---|
| **Ask before edits** (`default`) | Tools that can change something ask first: file edits, deletions, shell commands, commits, input to a background task and MCP tools. Read-only tools, and shell commands that are clearly read-only, run without asking. |
| **Accept edits** (`acceptEdits`) | `write_file`, `edit_file`, `multi_edit` and `apply_patch` run without asking. Deletions, commands, commits and MCP tools still ask. |
| **Plan mode** (`plan`) | Read-only. Anything that would change something is blocked. The model researches, then submits a plan for your review. |
| **Bypass permissions** (`bypass`) | Everything that would ask runs without asking. |

Some things ask even when the mode would allow them:

- Writes under a protected folder (`.git`, `.cubex`, `.claude`, `.agents`, `.codex`, `.vscode`, `.husky`) ask in every mode except Bypass, because changes there can alter how git or other tools execute.
- A tool call that Cubex had to recover from the model's text, instead of receiving it as a real tool call, always asks, even in Bypass.
- `web_fetch` to a host that is not on the built-in list of documentation sites asks once per host per turn.
- `consult_agent` asks before the first message to each other agent in a reply, with the whole message in front of you. Bypass approves it, and a saved rule never does.

A PreToolUse hook can still block a call in every mode, and the workspace path checks always apply.

The approval card offers **Always allow** for calls that can be generalized safely. A rule is saved for that project, listed under **Permissions** in Settings, and can be removed there. A rule can cover a simple command such as `npm test`, `npm run build`, `cargo test`, `pytest` or `tsc`, `write_file` and `edit_file` edits in that folder (only when created in Ask before edits), one `web_fetch` host, or one MCP tool. Rules are never offered for deletions, shells and interpreters, network tools, commands with shell syntax, or any call that carries a risk notice.

An operating-system access denial is not something approval can fix. Cubex reports it as an access problem and tells the model not to repeat the command or switch shells to get around it.

## Plan review

Cubex can research a task in Plan mode, save a Markdown proposal, and wait for your decision before implementing it. Plans belong to the task that created them.

1. Select a project folder and choose **Plan mode** in the composer before you send the task.
2. The model researches the project and submits the complete document with `exit_plan_mode`. Cubex saves it and opens a review panel.
3. Read the rendered **Preview**, or switch to **Source** to see the Markdown. The panel also has **Copy Markdown**, **Reveal plan file** and, when the task has more than one submission, a version selector.
4. To ask for changes, choose **Reject plan**, write your feedback and choose **Send feedback**. You can also reject without feedback. The model stays in Plan mode, receives your guidance, and must submit a complete new revision before it implements anything.
5. To proceed, pick the permission mode for the work (Ask before edits, Accept file edits or Bypass permissions) and choose **Approve plan**. The same turn continues in that mode, with no extra "go ahead" message.

While a plan awaits review, implementation stays paused. Closing the panel decides nothing; reopen it from the plan card in the conversation. Stopping the turn cancels the pending review, and a review still pending when the app exits is cancelled when the task loads again. An old approval never authorizes a later turn.

### Where plans are stored

Every `exit_plan_mode` submission creates a new `.md` file, and an older revision is never overwritten. A `.json` receipt beside it records the title, times, review status, chosen mode and feedback.

```text
<data folder>/plans/<task hash>/<title slug>-<short id>.md
<data folder>/plans/<task hash>/<plan id>.json
```

Plans are stored outside your project, in the data folder described in [DEVELOPMENT.md](DEVELOPMENT.md#where-data-lives). Use **Reveal plan file** for the exact location. The model passes Markdown to `exit_plan_mode`. It does not choose a path or use `write_file` for the plan.

A plan can be at most 128 KiB of UTF-8 text, the title at most 160 characters, and feedback at most 8,000 characters.

In a later turn of a task that has saved plans, the model sees a catalog of up to ten recent revisions and gets `read_plan`. With no arguments it returns the latest revision. With `{ "id": "<plan id>" }` it returns that revision with its status and any feedback. It takes an id, not a path, and cannot read another task's plans. Reading a rejected, cancelled or old approved plan grants no permission.

## Built-in tools

File, shell, task and git tools need a project folder. The others work without one.

| Tool | Purpose | Asks first |
|---|---|---|
| `list_files`, `glob_files`, `read_file`, `search_files` | Explore the project | No |
| `write_file`, `edit_file`, `multi_edit`, `apply_patch` | Change files | Yes, unless the mode allows it |
| `remove_file` | Delete one file | Yes |
| `run_command` | Run a shell command | Yes, unless it is clearly read-only |
| `read_command_output` | Page through saved command output | No |
| `task_list`, `task_output`, `task_stop` | Watch and stop background tasks | No |
| `task_input` | Send a line to a background task | Yes |
| `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame` | Read git state | No |
| `git_commit`, `git_branch` | Commit, create a branch | Yes |
| `web_search`, `web_fetch` | Search the web, read a page | `web_fetch` asks for a new host |
| `todo_write`, `ask_user_question` | Keep a checklist, ask you a question | No |
| `exit_plan_mode`, `read_plan` | Submit and recall plans | Plan review |
| `skill` | Load a skill's instructions | No |
| `delegate_to_subagent` | Hand a research task to a subagent | No |
| `consult_agent` | Ask another agent you set up for its view, and talk it through | Once per agent in a reply |
| `mcp__<server>__<tool>` | A tool from an MCP server | Yes |

Calls that only read and need no approval (`read_file`, `list_files`, `glob_files`, `search_files`, `read_command_output`, `skill`, `web_search`, and `web_fetch` to an approved host) can run side by side, up to four at a time. Anything that changes something runs alone, in order. If the model repeats an identical call more than three times, or repeats a call that already failed without anything changing, Cubex skips it and tells the model to change approach. More than six `web_search`, `web_fetch` or `search_files` calls in one turn are skipped the same way.

## Finding and reading files

Paths are relative to the project root and use `/`. Anything that resolves outside the root, including through a symbolic link or junction, is rejected. `list_files`, `glob_files` and `search_files` leave out files matched by `.gitignore` and dependency, build and version-control folders such as `node_modules`, `dist` and `.git`. Name an ignored folder directly as the path to look inside it.

**`glob_files`** finds paths without reading contents:

```json
{ "pattern": "**/*.{ts,tsx}", "path": "src", "limit": 100 }
```

The pattern is relative to `path` (default: the project root). A pattern with no `/` matches names at any depth. The syntax is `*`, `?`, a whole-component `**` and brace alternatives such as `{ts,tsx}`. Negation and character classes are not supported. Results are files only, sorted alphabetically, and symbolic links are skipped. The limit defaults to 100 and cannot exceed 500. A search stops at 20,000 entries, 64 directory levels or 5 seconds, and says when it was cut short. Patterns are limited to 512 characters and 32 expanded alternatives.

**`read_file`** returns the exact text of a UTF-8 file up to 256 KiB. For larger files or a focused look, ask for a page:

```json
{ "path": "src/main/ChatService.ts", "offset": 120, "limit": 80 }
```

`offset` is the 1-based first line. A page is 200 lines by default and at most 2,000, with line numbers (turn them off with `line_numbers: false`) and a hint for where to continue. Lines longer than 4,096 characters are cut and marked, and one call scans at most 32 MiB. A partial page does not count as having read the whole file when the model later tries to overwrite it.

**`search_files`** looks inside one file or a folder:

```json
{ "path": "src", "query": "retryAfter", "limit": 100 }
```

The query is a case-insensitive substring by default. Set `regex: true` for a JavaScript regular expression of up to 500 characters, and `case_sensitive: true` to match case exactly. Results look like `path:line: text`. Naming a single file searches that file only, even if it has no extension or is ignored by git. A folder search reads known text file types, up to 2,000 files, 16 MiB of content and 5 seconds, and each file may be at most 256 KiB. A regular expression that takes more than 500 ms on one file stops the search and says which file. The limit defaults to 100 and cannot exceed 500.

**`list_files`** lists a folder, folders first, capped at 500 entries with a count of what is not shown.

## Changing files

The file tools share one rule: the model must have read a file in the current turn before it changes it, and a change is refused if the file changed after that read. A partial read allows edits only to the text it showed. Overwriting with `write_file`, `replace_all` in an edit, and `remove_file` each need a current full read.

- **`edit_file`** replaces an exact `old_string` with `new_string`. The match must be unique unless `replace_all` is set. Line endings (CRLF or LF) and a byte order mark are preserved, so the model writes plain newlines. A failed match reports the closest region or the matching line numbers.
- **`multi_edit`** applies up to 100 such edits to one file in order and writes the file once. If any edit fails, nothing is written and the error names the edit.
- **`apply_patch`** applies a patch to several files in the `*** Begin Patch` format: add, update (with optional move) and delete. Everything is validated before anything is written, and the patch is all or nothing. It accepts up to 200 files and 4 MiB per call.
- **`write_file`** creates a file or fully rewrites one. It never overwrites a file that appeared since the model last looked.
- **`remove_file`** deletes one regular file. It never deletes folders and never follows symbolic links.

Writes replace the file atomically through a temporary file, and files over 32 MiB are refused. After an edit to a TypeScript or JavaScript file in a project that has a `tsconfig.json` or `jsconfig.json` (at the root or up to two levels down), Cubex type-checks the file and appends any new errors to the tool result, so the model can fix them in the same turn. The check uses the `typescript` package found from the project folder, with a copy installed alongside the app as the fallback when there is one. If none is found, edits are not checked and **Type checking** in Settings says why. The same group has a switch to turn the check off.

Shell commands can change files too. Cubex does not track those edits for checkpoints or review.

## Shell commands

`run_command` runs a command in the project folder. Which shell it uses is a setting (**Settings, Shell**): on Windows Git Bash, PowerShell 7, Windows PowerShell or Command Prompt, otherwise `sh`. With the setting on automatic, Cubex uses the first one installed in that order. The model is told which shell it is writing for. Each command's text reaches the shell as a single argument, so a path with spaces or quotes is not mangled by an extra quoting layer.

In Ask before edits, a command asks first unless it is a plain read-only probe such as `ls`, `cat`, `grep`, `git status` or `npm ls`, with no shell operators and every path argument inside the project. Plan mode blocks every other command.

Commands run with a cleaned environment: variables that look like credentials (`CUBEX_*`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `ANTHROPIC_*`, `OPENAI_*` and similar) are not passed on.

**Foreground** commands default to a 60-second timeout and allow at most 5 minutes. The result has the exit status and a preview of the combined output. Cancelling ends the whole process tree and reports it if that fails.

**Background** commands (`background: true`) are for servers, watchers and anything that keeps running. The call returns a task id after `yield_ms` (default 10 seconds, between 0.25 and 30) or as soon as the process prints a ready line such as a listening address. Then:

- `task_output` reads new output, optionally waiting up to 30 seconds for it.
- `task_list` shows the live and finished tasks of the conversation.
- `task_input` writes a line to the task's standard input and asks first. On Windows a task runs on a pipe without a console, so Ctrl+C cannot reach it and there is no interrupt. On other systems `interrupt: true` sends SIGINT.
- `task_stop` ends the task and every child process with a forced kill.

A task has a wall-clock limit of 30 minutes by default and 2 hours at most. Each conversation can have 8 live tasks and the app 16. Stopping a turn ends the background tasks that turn started, and only those. A task from an earlier turn keeps running until you stop it, delete the conversation or quit. The **Tasks** tab in the right-hand panel lists them with their output and a Stop button.

### Saved command output

Each foreground command saves its output so the model can read more of it without running the command again. The tool row has **View saved output** for paging through it, wrapping lines, copying a page or revealing the log. The model uses `read_command_output`:

```json
{ "output_id": "<id returned by run_command>", "offset": 0, "limit": 16384 }
```

Offsets and limits are UTF-8 bytes. Follow the returned `nextOffset` until `eof`. A page defaults to 16 KiB, allows 4 bytes to 64 KiB, and never splits a character. Ids belong to the conversation, and file paths are not accepted. Each command keeps at most 2 MiB, and each task keeps its newest 50 outputs. The model sees a catalog of up to ten recent ones.

Truncation and capture failures are reported separately from the exit status, so a successful command can still have an incomplete log. If Cubex exits before a log is finished, the saved part is recovered as **Interrupted**, with the original length unknown. Logs are stored as `<data folder>/command-output/<task hash>/<id>.log` and `.json`. They are local, unencrypted files containing the command and its output.

## Git

Five tools read git state and never ask: `git_status`, `git_diff`, `git_log`, `git_show` and `git_blame`. They cap their output, and they decline to read the working tree when the repository's own configuration defines programs git would run (such as filters) or points git at a different folder. `git_commit` commits exactly the paths it is given, or every modified tracked file when none are given, runs the repository's hooks, and never pushes, amends or skips hooks. `git_branch` only creates new branches. Both ask every time, and Plan mode blocks them. There are no tools for push, reset, clean, rebase or stash.

## Web

`web_search` queries DuckDuckGo's HTML results page, with no API key, and returns up to eight titles, links and snippets. It is best-effort and depends on that page's layout. `web_fetch` reads a public `http` or `https` page as text, up to 2 MB and 50,000 characters, with a 20-second timeout and at most five redirects. It refuses addresses on private, loopback or link-local networks, checks the address it actually connects to on every redirect, and refuses URLs with embedded credentials. Pages from a short list of documentation sites load without asking. Any other host asks once per turn.

## Reviewing what a task changed

The **Changes** tab shows every file the task changed through the file tools, compared with its state before the task began. Files are split into hunks.

- **Keep** marks a hunk as reviewed. **Undo** reverts it against the file's current contents. If the file has changed in the meantime, Cubex reports a conflict instead of overwriting, and anything applied with loose context is shown and can itself be undone.
- An undone change shows **Bring it back**, which puts Cubex's change back. Undo and Bring it back wait until the running turn has finished, and an undo can be reversed until you send the next message.
- A comment on a line range is queued, and **Send comments to Cubex** delivers all queued comments to the model as one structured message that starts a turn.
- A file changed outside Cubex after its last edit is marked, and binary or very large files are reviewed per file instead of per hunk.
- The commit sheet writes a suggested message and commits the files you select, using git.

Originals are kept on disk in `<data folder>/session-changes/`: up to 5 MiB per file and 64 MiB per task. A file whose original was too large to keep is reported as changed but cannot be restored.

**Restore** goes back to just before an earlier message of yours: the files, the conversation or both. Files that changed outside Cubex are left alone and listed, and a restore can be undone until you send the next message. Restoring files needs the turn's checkpoint, which Cubex keeps in memory, so after a restart you can still restore the conversation but not the files. Checkpoints and review cover the file tools only.

## Context and cost

The context meter in the composer shows how much of the model's window the next request will use. Click it for a breakdown by system instructions, conversation, tool results, built-in tool definitions, MCP tool definitions and attachments, with the sources of the system instructions (Cubex's own, yours, the project's, skills and saved plans) and each MCP server's share. The numbers are estimates from character counts, deliberately on the high side, and are corrected against the provider's own reported input count as soon as one arrives. They include the tool schemas actually sent. Draft text in the composer is not counted, and binary media is listed separately as unknown instead of being counted as free.

Cubex can summarize older messages so a long task keeps fitting. **Summarize earlier messages** (or `/compact`) does it on demand. Automatically, it happens before a request that reaches 80 percent of the usable input budget, once the task has at least three user turns. The threshold is adjustable from 50 to 95 percent under **Summarizing** in Settings. The summary is a billed model request. The full conversation stays on screen, in the database, in search and in exports. Only what the model receives changes, and **Restore full context** brings the whole history back. If a summary fails, the turn continues with the full context. Before summarizing, Cubex can replace old tool output with short stubs during a long turn, which is on by default.

**Budget** in Settings sets optional dollar caps per turn, per task and per day. Cubex warns at 80 and 100 percent, or with the action set to Stop it ends the turn before the request that would pass a cap. Spend comes from the usage ledger and counts only requests that have a cost. A provider that reports its own cost with a response (OpenRouter does) gets a figure. A model with no known price shows as "No price" in the usage view and adds nothing to totals or caps. Local models cost nothing and are never capped.

## Extending the agent

**Project instructions.** At the start of each turn Cubex reads `CLAUDE.md`, `AGENTS.md` and `.cubex/AGENTS.md` from the project root (identical files are included once, up to 48 KiB in total) and gives them to the model as project context.

**Skills** are Markdown workflows the model loads on demand. See [SKILLS.md](SKILLS.md).

**Subagents.** `delegate_to_subagent` hands a self-contained research task to an isolated child that sees only the task and context it is given. The child can use `read_file`, `list_files`, `glob_files`, `search_files`, `read_plan` and `skill`. It cannot edit files, run commands, use the network, ask you anything or delegate further, and its file reads do not satisfy the parent's read-before-edit rule. By default it gets five research rounds followed by one report, 16 tool calls and 120 seconds. A tool result is capped at 16,000 characters, all tool results at 96,000, and the report at 24,000. Parent cancellation stops it. Its tool rows are labelled **Subagent**. Role profiles in `.cubex/agents/*.md` or `.claude/agents/*.md` (a `name` and `description` in the frontmatter, the prompt as the body) give the model named roles to delegate to.

**Other agents.** `consult_agent` lets the model send a message to another agent you added under **Other agents** in Settings and turned on for the chat: Claude Code, Antigravity, another program, or a model of one of your providers. It talks the question through for up to the number of messages you set, and reports what was agreed and what is open. See [OTHER_AGENTS.md](OTHER_AGENTS.md).

**MCP servers.** Under **MCP servers** in Settings, add a command, a JSON array of arguments and optional environment variables. For example, `["-y", "@modelcontextprotocol/server-filesystem", "C:\\My Project"]` passes the folder as one argument. The command is an executable, not a shell command line. Malformed JSON, non-string entries, null characters and oversized input are rejected with an inline error. Only servers that speak MCP over standard input and output are supported. Cubex connects when a turn starts, keeps the connection between turns, reconnects a dead one, and restarts a server when its command, arguments or variables change. **Test** starts the server and lists its tools. Tools appear to the model as `mcp__<server>__<tool>` and always ask. Variables marked **Secret** are kept in the operating system's credential store, never in the settings file, and a server whose secret is missing is not started. A server only receives variables you set on its entry plus the cleaned environment described above.

**Hooks.** Under **Hooks** in Settings, a hook runs a shell command on an event and receives the event as JSON on standard input. The events are `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. An optional matcher limits tool events to tool names that contain any of its terms, separated by `|`, ignoring case. Only `PreToolUse` can block, by exiting with code 2 or printing `{"decision":"block","reason":"..."}`. It runs after you approve the call and before the tool does. A hook that fails or runs longer than 10 seconds counts as no objection. Hooks run as you, with no sandbox, so treat them like any script you would run yourself.

## Working while a turn runs

- **Queue.** A message sent while a turn runs is queued, up to 20, and sent when the turn finishes normally. The queue holds while the turn waits for an answer, after a failed or stopped turn, and when no model is selected. Queued messages are kept in memory only.
- **Stop** (Esc) ends the turn. Partial text is kept and unfinished tool rows are marked interrupted.
- **Notifications.** Cubex can show a desktop notification, flash the taskbar and set a badge when a session needs your approval, an answer or a plan review, finishes, or fails. They are on by default and stay quiet while Cubex is the window in front. **Settings, Notifications** has the switches.
- **Order.** The conversation is one ordered timeline of text, reasoning and tool activity. A tool's start and result update the same row, and parallel tools keep their positions. The main process numbers the events of each stream, and the window ignores older or replayed events and anything from a stopped stream. A provider error keeps the partial response. While tool arguments stream, the conversation shows that a tool is being prepared without showing partial arguments. Reasoning is shown only when the provider publishes it, and Cubex does not invent progress.
- **Records.** Messages are stored in full. Display metadata for tool rows is stored with them, capped at 1 MiB and 128 blocks per message, and tools left running become interrupted, never successful by inference. Unsent composer text and attachments follow their task but exist only in memory. Composer text is limited to 500,000 characters.
- **Attachments.** Text and source files are decoded as UTF-8 and counted under Attachments: up to 256 KiB per file, 1 MiB per message and eight files. Images are sent as images, up to 5 MiB each and 20 per message. PDF, Office, audio, video and other binary files are refused with a message.

## Checking changes to this area

Focused tests for plans, file tools and the system prompt:

```bash
npx vitest run src/main/plans.test.ts src/main/ChatService.plans.test.ts src/main/tools/planTool.test.ts src/main/tools/fileTools.test.ts src/main/systemPrompt.test.ts
npm run typecheck
```

For the interface, use the browser preview described in [TESTING.md](TESTING.md#visual-checks), and Electron (`npm run dev`) to check rejection with feedback, a revised submission, each approval mode, closing and reopening the panel, version selection and cancelling a pending review.
