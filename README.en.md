# dsh-deepseek-switch

A **Chat / Harness dual-workspace switcher** for the **DeepSeek Harness** desktop app. In one window you get the official `chat.deepseek.com` page inside an embedded WebView (with the login surviving app restarts) next to the original Harness agent workspace (sessions, workspaces, tasks and tools untouched).

Chinese documentation: [README.md](README.md).

---

## What it does

- Adds one **Chat** row to the sidebar (right under *New Chat*). Clicking it opens the official page as a workspace; `Alt+2` (or clicking the row again) returns to the Harness panel you came from.
- The Chat area is the **real official page**, not a look-alike: login, messages, uploads and history are all official behaviour.
- Switching only toggles visibility — the WebView is never rebuilt (4 round trips measured, 0 new guest instances).
- Returning to Harness calls `layout.selectPanel(lastPanel)`, so **no new session is created**.
- Login state is snapshotted to `~/.dsh/dsh-deepseek-switch/session.json` and written back before the first navigation on the next launch; verified on 0.2.1-rc.2 (the page still shows the signed-in greeting after a restart).

## Status

| Capability | State |
|------------|-------|
| Sidebar entry + main workspace panel | ✅ |
| Native titlebar and window controls stay uncovered | ✅ |
| Chat ⇄ Harness switching (`Alt+1` / `Alt+2`) | ✅ |
| No new session on return, previous panel restored | ✅ |
| No rebuilt WebView, no duplicate windows | ✅ |
| Login survives app restart (page `localStorage` + non-HttpOnly cookies) | ✅ measured on 0.2.1-rc.2 |
| HttpOnly partition cookies (`ds_session_id`, WAF keys) | ❌ unreachable in this architecture |
| Mode memory across restarts | ✅ |
| Page failure card: retry / open in browser / back to Harness | ✅ (offline case not measured) |
| SSO between the official web login and the Harness account | ❌ no official interface |

## Requirements

- **DeepSeek Harness desktop 0.2.1-rc.2** — the only version this plugin has been tested on (`engines.dsh: ">=0.2.1-rc.2"`).
- Node.js ≥ 22, only for running the tests.
- Verified on Windows 11; other platforms untested.

## Install

The plugin is a standard Harness **bundle** (`dsh.bundle.patch` + `dsh.client`). **Restart Harness afterwards** — the host half only loads at process start.

### A. From inside Harness (recommended)

```text
plugin_manager install_bundle target=github:luo173176/dsh-deepseek-switch
```

`target` accepts an npm package name, a git URL, a tarball URL, or an absolute local directory. If the result says `restart-required`, restart the app.

### B. Command line

```powershell
# quit Harness first: the profile package.json is locked while it runs
npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile desktop add github:luo173176/dsh-deepseek-switch
```

`dsh plugin --profile <name>` runs pnpm inside that profile. Measured on 0.2.1-rc.2: installing into a fresh profile also selects the bundle (`dsh.profile.bundles` gains `dsh-deepseek-switch`), but the reserved `desktop` profile takes the plain-pnpm branch and does **not** select it — there you still enable it with `plugin_manager` (`list_bundles` / `set_bundle`) or the plugin page.

### C. Local development

```powershell
git clone https://github.com/luo173176/dsh-deepseek-switch.git
```

```text
plugin_manager install_bundle target=<absolute clone directory>
```

### Verify

```text
plugin_manager list_plugins     # dsh-deepseek-switch with fiberPhase=active
plugin_manager list_bundles     # the bundle is listed
```

`%USERPROFILE%\.dsh\dsh-deepseek-switch\diag.ndjson` should contain an `apply` line with `route: /dsh-deepseek-switch/rpc`.

## Usage

| Action | Result |
|--------|--------|
| Click the sidebar `Chat` row | Open the official page workspace |
| `Alt+1` | Same |
| `Alt+2` | Back to the Harness panel you came from |
| Click `Chat` again | Back to Harness (the row toggles) |
| ⟳ in the Chat toolbar | Reload the official page only (see below) |
| Sidebar *New Chat* | Native Harness session, unrelated to this plugin |

### Refreshing the Chat page

A session created elsewhere (phone, another browser) is not picked up on its own. The ⟳ button in the Chat toolbar reloads the official page:

- it calls `reload()` on this `<webview>` — same partition, same instance, same page context, so cookies and `localStorage` stay put and **you stay signed in**;
- only Chat is affected; Harness sessions, panels and running tasks are untouched, and no second window or instance is created;
- while loading the button is disabled and spins, and repeat clicks are ignored by the `refreshing` state machine; loading ends on `did-stop-loading` / `did-fail-load` / `destroyed`;
- nothing is cleared: no cookie wipe, no storage wipe, no snapshot deletion. The usual gated save still runs afterwards, so a signed-out blank page cannot overwrite a good snapshot;
- it guarantees the page fetched fresh data, **not** that the official service has already propagated a change made on another device — the plugin never claims "synced".

## How login persistence works

Root cause measured on 0.2.1-rc.2: the main process mints the embedded browser partition as `dsh-sidebar-browser-<randomUUID()>`, so the cookie container changes on every launch; and the Harness host half runs in a Node-mode child process (`ELECTRON_RUN_AS_NODE=1`) where `require('electron')` only yields the binary path, so `session.cookies` is out of reach.

This plugin therefore keeps a **user-level snapshot**:

1. after the page loads, the client hands the `chat.deepseek.com` `localStorage` and `document.cookie` (AWS WAF keys stripped) to the host half;
2. the host writes `~/.dsh/dsh-deepseek-switch/session.json` (`.tmp` → `rename`, `0600` on POSIX), restricted to the `deepseek.com` domain;
3. on the next launch it creates an `about:blank#<lease>` container, restores the snapshot, applies the page state after the first load, reloads once, and only enters the `done` state afterwards;
4. every automatic save is gated until restoration finishes, so **a blank page cannot overwrite the snapshot**; a corrupt snapshot is reported and preserved.

| Data | Path |
|------|------|
| Login snapshot | `%USERPROFILE%\.dsh\dsh-deepseek-switch\session.json` (follows `DSH_HOME` when set) |
| Mode memory | `%USERPROFILE%\.dsh\dsh-deepseek-switch\state.json` |
| Diagnostics | `%USERPROFILE%\.dsh\dsh-deepseek-switch\diag.ndjson` — stages and counts only, no cookie values or names |

Security: the snapshot stays in the current user's home directory, is never uploaded, and is excluded from this repository. Treat it like browser credentials. The plugin does not copy cookies from your system browser or other apps, does not forge tokens, and does not bypass CAPTCHAs or site protections.

**Sign out / clean up**: sign out inside the official page, or delete `session.json`.

## Known limitations

1. **HttpOnly partition cookies are unreachable** in the Node-mode host. Login currently relies on `localStorage.userToken`; if the site moves auth entirely into HttpOnly cookies, this route stops working.
2. **Version coverage is narrow**: tested on `0.2.1-rc.2` only. A changed embedded-browser implementation (partition rules, lease protocol) needs a plugin update.
3. **No SSO**: the Harness account is its own platform token, separate from the `chat.deepseek.com` web login; no official sharing interface exists, and the plugin never reuses the Harness token as a web login.
4. **Site risk control is not bypassed**: CAPTCHAs or environment checks may appear inside any embedded browser.
5. **Chat history is not shared**: web history stays on the web, Harness sessions stay in Harness.
6. **Offline / site markup changes**: the failure card offers retry, open in browser, and back to Harness.
7. **The refresh button only reloads the page**: it makes the embedded page fetch fresh data, but does not change how fast the official service propagates changes made on another device; the plugin never claims "synced".

## Registered once (duplicate loader entries)

**Symptom.** Updating another plugin fails with

```
@local/dsh-deepseek-switch: duplicate loader entry id "deepseek-switch" (2 rows)
```

and the plugin list shows two `DeepSeek Switch` rows.

**Cause: a second registration of the same directory left in the profile.** The package used to be installed as `@local/dsh-deepseek-switch`; after the rename to `dsh-deepseek-switch` both names stayed in `dependencies` and in `dsh.profile.bundles`, both `link:`-ing to the same directory. Every `dsh.profile.bundles` entry becomes one layer (`buildBundleLayers` in `dshmarket/src/check.ts`), both layers expand the same `cordis.patch.yml`, and its single `- id: deepseek-switch` row ends up claimed twice. `remove_bundle` refuses the running `@local/...` entry, so a restart does not heal it.

**Fix.** The host half runs `deduplicateRegistration()` on every `apply`: it keeps only the entry whose `node_modules/<name>` resolves (via `realpath`) to this package's own directory, deletes the rest from `dependencies` and `dsh.profile.bundles`, copies `package.json.bak-<timestamp>` first, writes atomically (`.tmp` + `rename`), removes the stale `node_modules/@local/...` link, touches nothing that resolves elsewhere, writes no file when the profile is already clean (idempotent), and records `{stage:"registration", changed, kept, removed, backup}` in `diag.ndjson`.

Measured on a real desktop profile: `changed:true, removed:["@local/dsh-deepseek-switch"]`, and a second run returns `changed:false`. Nothing is hidden or filtered from the list — the second row is gone because the second registration is gone.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No `Chat` row | `plugin_manager list_plugins` → `fiberPhase`; `pending` usually means a missing dependency or a profile that was not restarted |
| `/dsh-deepseek-switch/rpc` 404 | Host half did not load: look for the `apply` line in `diag.ndjson`; host changes need an app restart |
| Blank Chat area | Check `guest-attached` and `did-fail-load` in `diag.ndjson`; use retry / open in browser |
| Login lost after restart | `client-boot`'s `snapshot` and `session-restore`'s `storage` count; `0` means the snapshot was never written or the page was not signed in |
| Duplicate title on top | This plugin draws no titlebar; another overlay plugin is stacking on top |
| A session created elsewhere is missing | Press ⟳ in the Chat toolbar; a `chat-refresh` line in `diag.ndjson` means it was issued |
| `duplicate loader entry id "deepseek-switch"` | See the section above; the `registration` line reports what was removed |

## Development

```powershell
npm test        # 12 host-half checks, offline, no login required
npm run check   # node --check index.js / client.js
```

```text
index.js                 host half: snapshot I/O, Electron probe, /dsh-deepseek-switch/rpc
client.js                client half: overlay WebView, sidebar entry, main panel, mode manager
cordis.patch.yml         bundle patch (inserts this plugin)
locale/{zh,en}.json      plugin title and description
icon.svg                 icon
test/host.test.mjs       host-half tests (12 cases)
```

## Credits and license

- The snapshot approach, the "pause automatic saves until restoration settles" rule and the WAF-key filtering were inspired by [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat) 0.7.8 (Apache-2.0). This plugin re-implements the ideas for its own architecture; no files were copied.
- MIT licensed — see [LICENSE](LICENSE).
- DeepSeek and DeepSeek Harness are product names of DeepSeek; this is a third-party plugin with no official affiliation.
