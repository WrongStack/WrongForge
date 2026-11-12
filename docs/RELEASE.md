# Releases

WrongForge ships as a **single-file executable** — no npm install, no Node on
the target machine. The webui dashboard and the default prompt guides are
embedded in the binary; everything else (tasks, sessions, logs, tokens) lives
in `~/.wrongforge` as before.

## Build locally

```bash
npm run build:binary        # needs bun on PATH (or BUN=/path/to/bun)
release/wrongforge-windows-x64.exe version
release/wrongforge-windows-x64.exe serve
```

What it does: `webui:build` → regenerate `src/embedded-webui.ts` from dist +
`prompts/` → `bun build --compile src/main.ts`. The checked-in
`src/embedded-webui.ts` is a stub (empty maps) so a source checkout keeps
typechecking; the build overwrites it — do not commit the generated copy.

## Release on GitHub

```bash
npm version patch          # or minor / major
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`: Windows + Linux
builds, sha256 checksums, assets attached to a GitHub Release
(`WrongStack/WrongForge`). Asset names are the contract `wrongforge update`
downloads — `wrongforge-<os>-<arch>[.exe]` (see `scripts/build-binary.mjs`).

The same tag also runs `.github/workflows/docker.yml`, which builds the
container image and pushes `ghcr.io/wrongstack/wrongforge:<version>` +
`:latest` to GHCR (GITHUB_TOKEN, `packages: write`). `workflow_dispatch`
lets you build/test the image without a release. See the Docker section in
the README for the runtime contract (`/data` volume, `HOST=0.0.0.0`).

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.ps1 | iex
```

Both verify the download against the release's SHA256SUMS.txt. Env overrides
for install.sh: `WRONGFORGE_REPO`, `WRONGFORGE_VERSION`, `WRONGFORGE_INSTALL_DIR`
(default `~/.local/bin`); install.ps1: `-Version`, `-Repo`, `-InstallDir`
(default `%LOCALAPPDATA%\Programs\WrongForge`, added to the user and current
PowerShell PATH). Both installers expose `wrongforge` regardless of the asset
name. Unix installs `~/.local/bin/wrongforge` and adds its absolute directory
to bash, zsh and fish startup files. Open a new terminal on Unix or use the
printed export command in bash/zsh. Existing unrelated terminals may need
restarting on Windows. Custom install directories are supported, including
paths containing spaces.

## Binary commands

| Command | Meaning |
|---|---|
| `wrongforge serve` | the HTTP API + dashboard (what `npm run serve` was) |
| `wrongforge update` | download the newest release asset for this platform, verify its sha256 digest, swap it in place of the running executable, restart with the same arguments |
| `wrongforge version` | version + repo |
| `wrongforge models` / `import` / `login` / `status` / `url` / (chat) | the source-mode commands, unchanged |

## Update checks

`serve` checks `github.com/<WRONGFORGE_UPDATE_REPO>/releases/latest` at
startup and daily (off with `WRONGFORGE_UPDATE_CHECK=0`; `WRONGFORGE_UPDATE_REPO`
overrides the repo). A newer release shows in the serve banner, the log
(`update.available`), `/v1/info` → `update`, and as a red chip in the
dashboard's top bar.

The swap: download → sha256 verify against the release digest → rename the
running exe to `<exe>.old.<pid>` (allowed on Windows) → move the new one in →
respawn with the same argv → exit. The rollback copy is pid-owned, so a
concurrent update never deletes another instance's copy; copies whose owning
process is gone are cleaned up on the next start. A release that publishes no
sha256 digest for the asset is **not installed** — the update fails closed
rather than installing unverified bytes. If the digest does not match, nothing
is installed either.

## Automatic updates

`WRONGFORGE_AUTO_UPDATE=1` turns `wrongforge update`'s manual flow into a
background one — **opt-in, off by default**: a binary replacing itself
unattended is a real behavior change, and existing installs (systemd/pm2
units, install scripts) should never be affected just by upgrading WrongForge.

Only the compiled binary can self-update at all (the same restriction
`wrongforge update` already has); a source checkout with the flag set logs a
warning once at startup and never arms the poller. When armed, every
`WRONGFORGE_AUTO_UPDATE_POLL_MS` (default 2 min) it checks: did the daily
update check (above) already find something newer, **and** is the server
idle right now (no queued or running task)? Only when both are true does it
download and verify the asset (`prepareUpdate()` — pure network, nothing is
torn down if this fails) and, only once that succeeds, close the listening
port and background work and install it (`installUpdate()`). An update is
never allowed to interrupt a task in progress, and a network hiccup during
the check never affects the running server — it just tries again next poll.

```bash
WRONGFORGE_AUTO_UPDATE=1 wrongforge serve
```

`/v1/info` → `auto_update: { enabled, supervised }` reports whether this is
actually armed (`enabled` is false in source mode even with the flag set) and
whether a supervisor (below) owns restarting the process afterward.

## Crash-restart supervisor

`WRONGFORGE_SUPERVISE=1` makes `wrongforge serve` become a small supervisor
process instead of the server itself: it spawns the real server as a child
and restarts it whenever it exits — a crash, or the respawn-free exit an
auto-update takes when a supervisor owns it (see above) — with capped
exponential backoff (1 s → 2 s → … → 60 s; a child that stayed up at least a
minute resets the backoff back to 1 s), so a persistently broken binary
cannot spin in a tight restart loop. **Off by default**, for the same reason
as automatic updates: a process that restarts itself after exit(0) is a
surprise unless asked for.

```bash
WRONGFORGE_SUPERVISE=1 wrongforge serve
```

The supervisor's own `Ctrl+C` / `SIGTERM` is the one case that does not
restart: the signal is forwarded to the child first, and only once the child
has actually exited does the supervisor exit too.

Combine both for a self-healing, self-updating server:

```bash
WRONGFORGE_SUPERVISE=1 WRONGFORGE_AUTO_UPDATE=1 wrongforge serve
```

Under a supervisor, the server passes `respawn: false` to `installUpdate()`
after an automatic update — the supervisor already restarts the process on
exit either way, so a self-respawn here would just race it for the port.

Out of scope here: registering as a Windows service (NSSM/`sc.exe`) or a
systemd unit — the supervisor is self-contained; a service wrapper is a
separate concern if ever needed.

## macOS note

The macOS binaries are **unsigned** — Gatekeeper quarantines them on first
run. Clear it once with:

```bash
xattr -d com.apple.quarantine wrongforge-macos-*
```

(or right-click → Open the first time). Code signing would require an Apple
Developer ID; it is not part of this workflow.
