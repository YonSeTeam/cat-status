# cat-status

A Claude Code mod built from function hooks that draws a pixel cat above the prompt, with a tiny presence server so friends' cats share one yard. `docs/development.md` (in Russian) covers the layout, the engine rules that have caused trouble before, and the server and its endpoints. Read it before changing code. The README is the public page: what the mod is and how to install it.

No server address lives in this repository. The mod gets one from `/cat server <url>` and sends nothing until then; the scripts get theirs from `CAT_*` environment variables. Keep it that way: no hostnames, IPs, key names or room codes in code, docs, tests or commits.

## Layout

- The repository root is the mod folder itself. On the maintainer's machine it is cloned straight into `~/.claude/mods/cat-status`, and `CLAUDE_CODE_PLUGIN_DIRS` points there, so a `git pull` is also an install.
- `hooks/register.tsx` is the whole mod.
- `types/index.d.ts` declares every `$.state` value the mod uses.
- Every word the mod shows lives in the `RU` and `EN` dictionaries at the top of `hooks/register.tsx`. New text goes into both; the `Words` type keeps them in step.
- `server/` is the presence server: plain Node with no dependencies, run in Docker on the server host. `server/public/install.md` is the setup guide friends' Claude Code follows.
- `scripts/` deploys over SSH to the host in `CAT_SERVER` (see `scripts/env.sh`). Run these scripts only when the person asks for a deploy.

## Setting up the mod on this machine

1. Clone this repo into `~/.claude/mods/cat-status`, or pull it there.
2. In `~/.claude/settings.json`, under `env`, set the three keys below. Keep the file valid JSON and leave every other setting as it is.
   - `CLAUDE_CODE_PLUGIN_DIRS`: the absolute path of that folder (`C:\\Users\\<name>\\.claude\\mods\\cat-status` on Windows). If the key already lists other folders, append this one with the OS path separator (`;` on Windows, `:` elsewhere).
   - `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`: `"1"`.
   - `CLAUDE_CODE_PLUGIN_DIR_WATCH`: `"1"`.
3. Open a new session. The cat appears above the prompt, and `/cat` lists its commands.

With the watch on, a pull or an edit reloads the mod without a restart. When a load fails, the transcript gets a dim `cat-status: reload failed …` line and the previous version keeps running.

The mod needs a Claude Code build whose plugin API has `$.agent.list`, the `agent.spawn` event and `classic.SubagentStart`. Builds 2.1.287 and later have all three. On an older build the module does not load, and the fix is to update Claude Code.

## Before committing

- `claude plugin validate .` must pass. It lists every hook and every `$` call. A new `$` call is a new capability, so say so in the PR.
- `claude plugin test .` runs `tests/*.test.ts` inside the engine, and every test must pass.
- `scripts/typecheck.sh` runs `tsc` against the installed engine's API: locally when Node is installed, otherwise in a throwaway container on `CAT_SERVER`.
- Never commit `.claude-plugin/types/`, `tsconfig.json` or `dist/`. The engine and the packer write those.

## Rolling out a merged change

Run these from the repo root on `main`, after `git pull`, with `CAT_SERVER` (and `CAT_SSH_KEY`, `CAT_PUBLIC_URL` where needed) set in the environment:

1. **If `server/` changed:** run `scripts/deploy-server.sh`.
   - It uploads `server.js`, `Dockerfile` and `public/install.md`, rebuilds and restarts the `cat-sync` container, and prints `/health`.
   - Rooms live in memory, so they empty on the restart and refill within one heartbeat (8 s).
2. **If the mod changed** (`hooks/`, `types/` or `.claude-plugin/plugin.json`): run `scripts/publish-zip.sh`. Friends install from that archive, so without this step they get the old version.
3. **Check the deploy:**
   - `curl "$CAT_PUBLIC_URL/health"` answers `{"ok":true,...}`.
   - The zip URL that `publish-zip.sh` prints answers 200.
4. **Friends update** by asking their Claude Code to follow `<server>/install` again, then opening a new session.

## Protocol changes

The beat payload is everything friends learn about each other.

- **Disclosure.** Anything new sent in it must also be listed in `server/public/install.md` (the paragraph «Что мод отправляет на сервер»), in the endpoint table of `docs/development.md`, and in the README's privacy section.
- **What never goes out.** File names, commands, prompts and agent descriptions, unless `/cat share on` covers them.
- **Compatibility.** Keep the server and the mod compatible in both directions, so either can roll out first:
  - the server treats new beat fields as optional;
  - the mod treats new member fields as optional (`asFriend` fills in the defaults).
