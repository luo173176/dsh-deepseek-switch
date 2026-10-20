# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/).

## 0.5.0 — 2026-10-20

Login state now survives a full application restart, and the project is published.

- **Added** user-level login snapshot (`session.json`): page `localStorage` + non-HttpOnly cookies under `deepseek.com`, written atomically (`.tmp` → `rename`, `0600` on POSIX).
- **Added** strict restore sequence: `about:blank#<lease>` container → snapshot read → first load → state write-back → single reload → `done`; automatic saves are gated until then, so a blank page cannot overwrite a good snapshot.
- **Added** AWS WAF cookie/key filtering (never snapshot a challenge token that belongs to a one-off challenge).
- **Added** `session-state` / `session-restore` / `session-save` RPC operations and an `electron` capability probe reported once at `apply`.
- **Added** 30 s autosave, `beforeunload` beacon save, and a final save on unload.
- **Added** diagnostics (`diag.ndjson`) that carry stages and counts only — no cookie values, no cookie names.
- **Changed** the host half declares `inject = ['webServer']`; the RPC route is root-absolute (`/dsh-deepseek-switch/rpc`) and origin-gated (`dsh-app://app`, the app's own origin, or no `Origin`).
- **Changed** package name to `dsh-deepseek-switch` for public distribution.
- **Removed** the optional `app.asar` patch tooling from the repository; the patch is not required for login persistence and is version-locked to one app build.

## 0.4.0 — 2026-10-20

- **Fixed** the duplicated "DeepSeek Chat" title and the text overlapping the native window controls: the plugin no longer draws its own titlebar; the overlay top edge is measured from the app frame's `paddingTop`.
- **Fixed** the one-way switch: the sidebar row now toggles, and `enterHarness()` only calls `layout.selectPanel(lastPanel)` — never the new-session path.
- **Fixed** duplicate surfaces: switching hides the guest instead of unmounting it.
- **Changed** `layout.selectPanel` retries once (120 ms) for a panel registry that syncs a tick late.

## 0.3.0 — 2026-10-20

- **Fixed** `sidebarRight: no session surface is mounted`: the sidebar column is structurally unavailable without an on-screen session surface, so the Chat workspace moved to a `shell.overlay` entry plus a `sidebar.panellist` row and a `main` panel.
- **Fixed** the host half never running: `apply` had no `inject`, so the plugin row stayed `pending` and `webServer` was undefined.
- **Added** `Alt+1` / `Alt+2` shortcuts and mode persistence in `state.json`.

## 0.2.0 — 2026-10-20

- **Added** the embedded `<webview>` carrier using the app's browser lease (`dshDesktop.browser.acquire`) — a third-party plugin cannot create a `<webview>` without a main-approved lease.
- **Changed** the client to `shell.overlay` instead of the sidebar column.

## 0.1.0 — 2026-10-20

- First working bundle: sidebar entry, main panel, mode state, `webServer`-backed persistence, six host checks.
