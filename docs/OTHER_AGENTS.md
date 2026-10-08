# Other agents

The agent in a chat can ask another agent for a second opinion and talk a question through with it until the two agree, or until a limit you set is reached. The other agent can be Claude Code, Antigravity (`agy`), any command line program that reads a message and prints a reply, or a model from one of your providers. This page covers how to set one up, what happens in a chat, what each kind of agent can see, and what leaves your PC. The code is in `src/main/peers` and `src/shared/peers.ts`. "Peer" is the name in code, and the interface says "other agents".

## Setting one up

1. Open **Settings**, then **Other agents**, and choose what to add:
   - **Claude Code** runs `claude`. **Let it read this project** gives it read-only tools in the open project. It is never allowed to change a file or run a command.
   - **Antigravity** runs `agy`.
   - **Another program** runs any command that reads a message and prints a reply, such as Codex or Gemini. You give it the arguments that come before the message, and say whether the message goes to standard input or is added as the last argument.
   - **A model** is a model of one of your providers, asked a plain question.
2. Choose **Test**. It sends the message "Reply with the single word OK." the way a chat would and shows what came back, how long it took and, when it failed, why and what to do about it.
3. In a chat, open the **+** menu in the composer and turn the agent on under **Other agents**. Each chat keeps its own choice.

The list holds up to eight agents. **Most messages to one agent per reply** is a number from one to six, three by default. Settings shows whether each program was found on this PC, and the Add menu says so for Claude Code and Antigravity before you add them.

## What happens in a chat

When an agent is on, the model has a tool called `consult_agent`. The model uses it when you ask it to consult or agree with that agent, or when a second opinion would help. It does not use it for routine steps.

1. Cubex shows you the whole message and which agent it is going to, and asks. This happens before the first message to each agent in a reply. **Bypass permissions** mode approves it without asking. A saved "Always allow" rule never covers it, because the message leaves for another program or service.
2. The agent is told it is being consulted, to give its own view with reasons, to change nothing, and to end with one line, `Verdict: agree`, `Verdict: partly agree` or `Verdict: disagree`.
3. The reply goes back to the model, wrapped as another agent's opinion and not as an instruction from you. The model reads it, answers the strongest point and may send another message, until the two agree or the limit is reached. A message that fails does not count as a round, and after two failures with the same agent in a reply the model stops asking it.
4. The model tells you what was agreed, what is still open and the strongest argument on each side. It does not change files because of a disagreement without asking.

The conversation shows a row for each message, named for the agent ("Ask Claude Code"), with the round, how long it took and the verdict as **Agrees**, **Partly agrees** or **Disagrees**. Open the row to read what was sent and what came back. The rows are kept in saved history.

A program answers one message and exits, and a model is asked one request at a time, so none of them shares a session with the chat. Each message has to carry what the agent needs. Cubex keeps what was said to each agent in the chat and sends the last six exchanges (40,000 characters at most, dropping the oldest first) along with each new message, so a later message continues the talk. That record is kept in memory only. It is gone when Cubex restarts or the chat is deleted.

## What each agent can see

| Agent | Where it runs | What it sees |
|---|---|---|
| A model | Its provider, through the same gateway as chat, and billed and counted like any request | The protocol, the earlier messages with it, and the new message. No tools and no files. |
| A program | On this PC, in an empty folder that Cubex creates and deletes afterwards | Only the message. |
| Claude Code with **Let it read this project** on | On this PC, in the project folder | The message and the files in the project, through read, search and glob tools only. |

A program is started without a shell, with Cubex's own credentials kept out of its environment (the same cleaning as for hooks and MCP servers, see [SECURITY.md](SECURITY.md)). A variable it needs, such as an API key, is named under **Variables to pass**, and only those are handed on. A program that is not signed in has to be signed in first: start it once in a terminal and follow its login steps.

Claude Code is started with `-p`, JSON output, **no tools** (or `Read,Grep,Glob` when it may read the project), only your user settings and not the project's, no MCP servers, nothing saved to disk, and a limit of 3 turns (12 with the project). It never gets `--dangerously-skip-permissions`, so a tool that would need permission is refused. Antigravity is started as `agy --output-format json -p "<message>"`. Both presets were written from the vendors' documentation and tested with stand-in programs. If either behaves differently on your PC, **Test** shows what it printed.

## What leaves your PC

A message to a program goes to that program, and most of them send it to their own cloud service under their own terms. A message to a model goes to that model's provider. Both can contain your code, because the model puts into the message what the agent needs to see. Read the message in the approval card before you allow it.

**Local-only mode** turns programs off, because nearly all of them reach a cloud service. A model agent follows the rule for providers: it works only if its provider is local. Neither is a network firewall, see [SECURITY.md](SECURITY.md#privacy).

## Limits and what Cubex does with output

- A message is at most 24,000 characters. A program that takes the message as an argument is limited by the command line (about 28,000 characters on Windows), and a program that reads standard input by 120,000.
- A program has ten minutes to answer, and is stopped with everything it started when the time is up or you stop the turn.
- Output is bounded (400,000 characters of standard output, the last 8,000 of error output), stripped of colour codes, scrubbed of anything shaped like a key, and read as data. A reply longer than 24,000 characters is shortened and says so. An agent cannot close the wrapper it is returned in.
- Programs that install as a Windows batch file (`.cmd`) cannot take a message that contains quotes, percent signs or line breaks as an argument, because `cmd.exe` would reinterpret them. Cubex says so and suggests an `.exe` or standard input.
- Antigravity before version 1.1.1 prints nothing on Windows when it is started without a terminal. Update it with `agy update`.

## Adding your own program

Choose **Another program** and enter the command, its arguments and where the message goes. A command that reads a prompt from standard input and prints the answer works with the defaults, for example:

| Program | Command | Arguments | Message |
|---|---|---|---|
| Codex | `codex` | `exec` `-` | standard input |
| A script | `node` | `reviewer.mjs` | standard input |

The arguments above are examples, so check how your program reads a prompt. Then **Test** it. A program that prints something other than the reply (progress lines, a banner) is read as plain text, so keep its output to the answer. The program runs in an empty folder, so a relative path in its arguments will not find your project.

## Where the code is

| What | Where |
|---|---|
| The settings, the presets, the checks | `src/shared/peers.ts` |
| The `consult_agent` tool, its approval text and the row it leaves in the conversation | `src/main/peers/consultTool.ts`, `src/renderer/src/components/ToolCard.tsx` |
| What an agent is told | `src/main/peers/framing.ts` |
| Starting a program, finding it, stopping it | `src/main/peers/peerRunner.ts` |
| Reading what it printed, and the verdict | `src/main/peers/output.ts` |
| What was said to each agent in a chat | `src/main/peers/transcript.ts` |
| Asking a model, approving, the round count per reply | `src/main/ChatService.ts` |
| Test and status handlers | `src/main/ipcModules/peers.ts` |
| The Settings page and the composer menu | `src/renderer/src/views/settings/sections/AgentsSection.tsx`, `src/renderer/src/components/chat/Composer.tsx` |
