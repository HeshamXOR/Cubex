# Releasing

A release is a tag on `main`. Pushing the tag starts `.github/workflows/release.yml`, which checks that the repository is ready, builds the Windows installer, attaches it to a GitHub release and publishes it. The text of the release comes from `CHANGELOG.md`. Cubex's own updater reads the latest GitHub release (see [UPDATES.md](UPDATES.md)), so what you publish is what every installed copy offers, with these notes in the window that opens.

## Steps

1. **Pick the version.** A patch for fixes, a minor version for features. Versions only go up: an installed copy ignores a release that is not newer than itself.
2. **Bump it.** `npm version 0.2.1 --no-git-tag-version` sets `package.json` and `package-lock.json` together.
3. **Write the notes.** In `CHANGELOG.md`, the section for the version has its date on the heading: `## [0.2.1] - 2026-10-20`. While a version is unreleased the heading says `Unreleased` where the date goes. The section is what people read in the update window, so write it for them: a sentence on what the version is about, then what is new, what changed and what was fixed, in plain words. Add **Good to know** for anything that can surprise someone. Leave out the download table and the checksum, because the workflow adds them under a line that the app does not show.
4. **Check it.** `node scripts/release.mjs check v0.2.1` says what is wrong, if anything. The workflow runs the same check first, and refuses the tag when it fails. `node scripts/release.mjs notes 0.2.1` prints the text the release will start with.
5. **Commit and push to `main`**, under your own name, and wait for CI to pass. The tag is refused unless its commit is on `main`.
6. **Tag and push the tag.**

   ```bash
   git tag -a v0.2.1 -m "Cubex 0.2.1"
   git push origin v0.2.1
   ```

7. **Watch the Release workflow** under Actions. CI alone takes about four minutes, and the release adds the installer build. The table below says what each step is for.
8. **Look at the result.** The release page shows the notes, the download table and the installer, and GitHub shows `sha256:` beside the file. In a copy of Cubex that is older, **Settings**, then **Updates**, then **Check for updates** offers the new version, and **What's new** shows the notes without the download table.

Nothing in the repository needs editing for a release except those three files: `package.json`, `package-lock.json` and `CHANGELOG.md`. The README and the documents say nothing that changes with the version.

## What the workflow does

| Step | Why |
|---|---|
| `scripts/release.mjs check` | The tag is `v` and three numbers, `package.json` and the lockfile are that version, and `CHANGELOG.md` has a dated section for it with something in it. |
| The tag is on `main` | A release comes from reviewed history, not from a branch. |
| Lint, type check, tests | The same as CI. A release is not built from a state that CI would refuse. |
| `npm run dist:win -- --publish never` | Builds `release/Cubex-Setup-<version>.exe`. `--publish never` keeps the build tool from publishing anything itself. |
| The notes and the checksum | `scripts/release.mjs notes` writes the release text, with the SHA-256 of the installer. `sha256sum` hashes the same file independently, and the job stops if the two disagree. |
| A draft release | The installer is attached to a **draft**, so nobody is offered it yet. A release that already exists for the tag makes this step fail, and nothing is overwritten. |
| What GitHub recorded | GitHub records a SHA-256 for every uploaded file. The updater installs only when that record exists, so the job reads it from GitHub and compares it with the file that was built. A mismatch leaves the draft unpublished. |
| Publish | The draft becomes the latest release. |

The build job has read-only access and keeps no token, because it runs the install scripts of the project's dependencies. Only the publish job can write to the repository, and it runs no project code beyond `scripts/release.mjs`, taken from the build that was checked. The workflow uses `GITHUB_TOKEN`; no secret is needed.

## Trying it without publishing

- **Locally.** `node scripts/release.mjs check v0.2.1 --allow-undated` accepts a heading that still says `Unreleased`, so you can check a version before it has a date. `npm run dist:win` builds the installer into `release/`.
- **In Actions.** Choose **Actions**, then **Release**, then **Run workflow**, on `main`. It runs every step up to and including the build and keeps the installer and the notes as a download of the run for 14 days. It publishes nothing, and the date on the changelog heading may still be `Unreleased`.
- **The whole update path.** `scripts/dev-update-feed.mjs` serves a release from your own computer, and `CUBEX_UPDATE_FEED` points Cubex at it. [UPDATES.md](UPDATES.md#trying-it-without-publishing) has the details.

## When something goes wrong

- **The check or the build fails.** Nothing was published. Fix it, commit, and move the tag onto the new commit: `git push origin :refs/tags/v0.2.1`, then `git tag -d v0.2.1`, tag again and push. Moving a tag is acceptable only because no release exists for it yet.
- **The checksum comparison fails.** The release is a draft that nobody can see. Open it under **Releases**, check the installer's checksum, delete the draft and the tag, and start again.
- **A release is published and wrong.** Do not replace its installer. People may have downloaded it, and GitHub has recorded its checksum. Publish a fixed version with the next number. To stop the bad one from being offered while you do, mark it as a prerelease or delete it: `releases/latest` then points at the one before it, and an installed copy that was offered the bad one drops the offer at its next check.
- **A tag was pushed by mistake.** Delete the tag on GitHub before the workflow reaches the publish step, or delete the draft afterwards. A published release is the case above.

## One-time setup

- Actions are on for the repository, and the default workflow permission can stay read-only: the publish job asks for `contents: write` itself.
- A tag rule or ruleset for `v*` limits who can create release tags. It is optional and worth having.
- GitHub's **immutable releases** setting can be turned on. It is meant for this order, where the files are attached while the release is still a draft.
- The first release with an updater, 0.2.0, cannot be reached by 0.1.0, which has no updater. Its notes say so. Everyone on 0.1.0 installs it once by hand.
