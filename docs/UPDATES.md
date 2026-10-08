# Updates

Cubex tells you when a new version is out, shows you what changed, and installs it when you say so. This page covers what you see, what Cubex checks before it runs anything, what it sends, and what a release has to look like for the app to use it. The code is in `src/main/updates` (looking, downloading, installing) and `src/renderer/src` (the card in the sidebar, the dialog and the Settings page).

## What you see

- **A card in the sidebar** when a newer release is out. **What's new** opens the release notes. **Download update** downloads the installer and checks it, and **Restart to update** then runs it. There are two steps on purpose: nothing restarts until you press the second button. In a window too narrow for the sidebar, a button in the title bar carries the same news.
- **Later** hides the card until something about it changes: a newer version, the next step, or an error to read. A quiet link stays in the sidebar, and Cubex forgets the choice when it restarts.
- **Skip this version** stops announcing that version. A newer one is announced again, and **Settings**, then **Updates** still shows the skipped one. Choosing **Check for updates** by hand ends the skip.
- **Settings**, then **Updates** shows the version you have, when Cubex last looked, the release on offer with the same buttons as the card, and the **Check automatically** switch.
- If sessions or background tasks are still working when you restart, Cubex says so and asks: **Wait**, or **Stop and update**.

## When it looks

About 20 seconds after the window first asks for the state of updates, and then every six hours while Cubex stays open. It does not look on its own when **Check automatically** is off, when local-only mode is on, or in a copy run from source. **Check for updates** works at any time, except in local-only mode.

A look is one request, `GET https://api.github.com/repos/HeshamXOR/Cubex/releases/latest`, with an `Accept` header, an API version header and `User-Agent: Cubex/<version>`. No cookie, token, account or identifier goes with it. GitHub sees your IP address, as any server does, and the version of Cubex you run. A draft or a prerelease is never offered, and neither is a version that is not newer than yours.

## What is checked

Everything a release says about itself is treated as untrusted text.

- The tag must be a version, and the release page must be on `github.com` under the Cubex repository. The address is parsed rather than matched as text, so `..` segments, user names in the address and look-alike hosts do not pass.
- The installer is the asset named exactly `Cubex-Setup-<version>.exe`, fully uploaded, from 1 byte to 500 MiB, at an address under `/HeshamXOR/Cubex/releases/download/` that ends in that name, with a `sha256:` checksum recorded by GitHub. A release without any one of these is still shown, with its notes, but Cubex will not install it. It sends you to the release page instead.
- The download follows GitHub's redirects itself, one step at a time, over `https` only, to `github.com` or `*.githubusercontent.com` only, up to five. A redirect anywhere else stops the download before it is requested.
- The size and SHA-256 are checked as the file arrives, and again right before it is run, because it sat on disk in between. A file that fails is deleted. A download that was cut off, or that you quit in the middle of, continues from where it stopped.
- The window never sees an address or a checksum. It asks for the next step, and the page it opens is the one the release was parsed to.

The installer is kept in `updates` inside the data folder. A newer download waits there for its restart. Once you are running a version, its installer and any older ones are deleted the next time Cubex starts.

## Installing

Only a copy that the Windows installer set up can replace itself: a packaged build with `Uninstall Cubex.exe` beside it. An unpacked or portable copy, a copy run from source and other platforms get **View release** in place of the download, with the reason in a sentence.

Cubex starts the installer as a separate process with `--updated /S --force-run` and quits only after it has really started. The installer waits for Cubex to exit, installs into the folder Cubex is already in, keeps your settings and shortcuts, and starts Cubex again. If the installer cannot start, Cubex stays open and tells you where the file is.

## What this does not protect against

- **The installer is not code-signed.** Windows SmartScreen may warn the first time you install by hand. The checksum comes from GitHub, over TLS, from the same place the release comes from. It catches a damaged download and a file swapped on the way. It does not protect against a release published by someone who controls the repository or its account. A signature from a certificate that belongs to the project would add that, and is not there yet.
- **Cubex 0.1.0 cannot update itself.** Install the first version that has this page once by hand. From then on updates are offered inside the app.
- **The window shows the notes of the newest release only.** If you skip a version, the notes of the one in between are on the release page.
- **The check does not use a system proxy.** Like Cubex's other requests, it is made by Cubex itself. On a network that only allows a proxy it can fail, and **View release** still opens the page in your browser.
- Windows is the only platform that installs by itself.

**Local-only mode** blocks the check and the download, and Settings says so. An installer that was downloaded earlier can still be run.

## Writing a release the app can use

The tag is `v` and three numbers, such as `v0.2.0`, and the release is not a draft or a prerelease. The installer is attached under the exact name above, and GitHub records its checksum when the file is uploaded.

The text of the release is the "What's new" window. Everything above a line that holds only `<!-- end of notes -->` is shown there, as Markdown (images and local paths are not loaded), up to 20,000 characters, and says so when it is cut. Everything below the line is for the release page, where a visitor does not have the app yet: the download table and the checksum. The release workflow writes that line, so a release made by it needs no care. A release made by hand without the line shows its whole text in the window.

[RELEASING.md](RELEASING.md) has the steps. `scripts/release.mjs` checks that the version, the lockfile and the changelog agree before anything is built, and `CHANGELOG.md` is where the notes come from.

## Trying it without publishing

`CUBEX_UPDATE_FEED` points a copy of Cubex at a feed on your own computer. It takes only an `http` or `https` address on `127.0.0.1`, `localhost` or `[::1]`, with no user name in it. Any other value is ignored and GitHub stays in place, so the variable cannot send an installed copy to another machine. With it set, downloads are accepted only from that same host and port.

`scripts/dev-update-feed.mjs` serves such a feed, in the shape of GitHub's answer, with a stand-in installer. It is not a real installer.

```bash
node scripts/dev-update-feed.mjs
node scripts/dev-update-feed.mjs --version 3.0.0 --size-mb 40 --rate-kb 2000 --notes my-notes.md
```

It prints the address and the commands that start Cubex with it. `--rate-kb` slows the download so you can watch it. `--no-installer` serves a release without an installer, `--bad-checksum` one whose checksum is wrong (the download must fail and delete the file), and `--installer <file>` serves a file of your own. Do not point `--installer` at a real Cubex installer and then restart: **Restart to update** runs it.

An unpacked build and `npm run dev` show the card and the dialog, but offer **View release** in place of the download, since only an installed copy can replace itself. To watch every state without a server, use the browser preview with `?seed=1&done=1&update=available`. [TESTING.md](TESTING.md#visual-checks) lists the other values.

To go through the whole path on a build you made yourself, from the first look to the restart:

1. Copy `release/win-unpacked` to another folder.
2. Create an empty file named `Uninstall Cubex.exe` beside `Cubex.exe`. That file is all Cubex looks for, so the copy now counts as installed.
3. Serve a harmless program as the installer, with `node scripts/dev-update-feed.mjs --installer <a program>`. Cubex runs it with `--updated /S --force-run` when you press **Restart to update**, and then quits. A program that only writes down its arguments is enough.
4. Start the copy with its own data, so it does not share the single-instance lock with an installed Cubex or touch your settings: `Cubex.exe --user-data-dir=<a folder>`, with `CUBEX_DATA_DIR=<another folder>` and `CUBEX_UPDATE_FEED=<the address the feed printed>` in its environment.

The first look comes about 20 seconds after the window opens.

## Where the code is

| What | Where |
|---|---|
| The state, the settings block, the limits | `src/shared/updates.ts`, `src/shared/version.ts` |
| Which feed to read, and which addresses a release may use | `src/main/updates/feed.ts` |
| Reading and checking a release | `src/main/updates/releases.ts` |
| Whether this copy can replace itself, and how the installer is started | `src/main/updates/installer.ts` |
| Looking, downloading, verifying, installing, skipping | `src/main/updates/UpdateService.ts` |
| The IPC handlers | `src/main/ipcModules/updates.ts` |
| The card, the dialog, the Settings page | `src/renderer/src/components/UpdateNotice.tsx`, `UpdateDialog.tsx`, `UpdateParts.tsx`, `src/renderer/src/views/settings/sections/UpdatesSection.tsx` |
| The window's copy of the state | `src/renderer/src/state/updates.ts` |
| The words | `src/renderer/src/lib/updateText.ts` |
