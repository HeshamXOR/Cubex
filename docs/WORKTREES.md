# Worktrees and racing models

A task can work in a checkout of its own, so that several tasks can change the same files at once and your project folder stays as it was until you bring a result back. Racing gives the same work to several models, each in its own checkout, so that you can compare what they did and keep the best.

Both need a git repository with at least one commit. Open them from the branch chip above the conversation: **New task in a worktree** and **Try on several models**.

## What happens

- Cubex runs `git worktree add` on a new branch, `cubex/<name>-<id>`, from the commit your project is on. The folder lives in `~/.cubex/worktrees/`, outside your project. Uncommitted changes in your project folder do not come along, and the dialog says so when there are any.
- The dialog shows the setup commands before anything runs, and you can change them. They run on your computer in each new copy. They come from the project's `.cubex/worktrees.json`, or are guessed from a lockfile when there is none.
- Whatever setup writes (a `package-lock.json`, say) and whatever is copied in does not count as the task's change, so it is neither shown in the comparison nor brought back.
- The task's saved permission rules are the project's: a rule you saved for `npm test` applies in its worktrees too, and a command is still judged in the folder it runs in.

```json
{
  "setup": ["npm ci"],
  "copy": [".env"]
}
```

`copy` lists plain files to bring from your project folder, because git does not carry ignored files over. It cannot reach outside the project or into `.git`.

## Bringing a result back

**Bring changes to the project folder** (in a race, **Use this one**) puts everything the task changed into your project folder as uncommitted edits, commits and new files alike, where you review them as usual. It is all or nothing. If any of it does not fit what is in your folder now, nothing is touched, and the branch is there to merge by hand.

**Discard** deletes the worktree and its branch, with whatever is in them. The conversation stays. Deleting a conversation removes its worktree only when the worktree holds no work. One that does stays on disk on its branch, and `git worktree list` shows it.

## Racing

Choose two to four models. It costs about that many times as much as asking one, and it is that many sets of approvals to answer: **Approve edits** is the default, so commands still ask you. All of them start only after every copy is set up, and a model whose setup failed does not run.

The compare page shows each run's state, the size of its change, its cost, and its diff. **Check every run with** runs one command in every copy and shows which passed. Cubex does not pick a winner for you. The research this is based on is clear that the gain comes from filtering on real checks rather than from an opinion about which diff looks better (see [BENCHMARKS](../evals/BENCHMARKS.md)).

## What this does not do

A worktree separates files, not programs. Commands an agent runs still run on your computer with your permissions, and a worktree does not stop one from reaching outside its folder.
