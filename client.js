/**
 * DeepSeek Switch — client half (v0.5).
 *
 * Two workspaces in one window. The switch entry is the single native sidebar row
 * (`sidebar.panellist` id `deepseek-chat`); the Chat page itself is a lease-approved
 * Electron <webview> that lives in `shell.overlay` and is never unmounted, so switching
 * modes never destroys the page or its session.
 *
 * v0.4:
 *  - no plugin-drawn title/status bar: the Chat surface is the official page, full height,
 *    starting below the native window titlebar band, so nothing overlaps the window controls
 *    and no second "DeepSeek Chat" heading is painted;
 *  - returning to Harness re-selects the main panel that was open before Chat (never
 *    startSession, never a new session), and clicking the sidebar entry again while Chat is
 *    active also returns;
 *  - a page that fails to load leaves a small error card with 重试 / 浏览器打开 / 返回 Harness,
 *    and the sidebar entry keeps working regardless of what the page does.
 *
 * v0.5 — the login survives a restart. The shell gives every guest a process-lifetime
 * partition, so before the page is navigated the host half puts the saved partition cookies
 * back (HttpOnly included, which only the Electron main process can write); the guest's own
 * localStorage and `document.cookie` come back with them and are applied after the first
 * load, then the page is reloaded once — already signed in. Until that settles every
 * snapshot is gated off, because the freshly loaded page still has empty storage and saving
 * it would erase the very snapshot being restored. Adapted from `@jaychang1989/dsh-webchat`
 * 0.7.8 (Apache-2.0); README §10 records what came from there.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MODES = { chat: 'chat', harness: 'harness' }
    const RPC = '/dsh-deepseek-switch/rpc'
    const DEFAULT_CHAT_URL = 'https://chat.deepseek.com/'
    /* One id serves both seats: the sidebar nav row and the main panel it selects. */
    const PANEL_ID = 'deepseek-chat'
    const CONVERSATION_ID = 'conversation'
    const WORKSPACE_KEY = 'dsh-deepseek-switch:chat'
    /* The one origin whose login state this plugin is allowed to move. */
    const CHAT_ORIGIN = 'https://chat.deepseek.com'
    /* Snapshot cadence; the host half can override it (0 disables it). */
    const DEFAULT_SAVE_INTERVAL_MS = 30000

    const state = {
      mode: MODES.harness,
      chatUrl: DEFAULT_CHAT_URL,
      persists: true,
      phase: 'idle',
      error: '',
      /* Login persistence diagnostics, shown nowhere by default: they only reach diag.ndjson. */
      session: { electron: 'unknown', savedAt: '', cookies: 0 },
    }

    let saveIntervalMs = DEFAULT_SAVE_INTERVAL_MS

    const listeners = new Set()
    function patch(next) {
      Object.assign(state, next)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('DeepSeek Switch: listener failed', error)
        }
      }
    }
    function useSnapshot() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return state
    }

    const text = (error) => (error instanceof Error ? error.message : String(error))

    /* ------------------------------------------------------------------ guest */

    let guest
    let acquiring
    let hostElement
    let appCtx
    /* The main panel that was selected before Chat: restored verbatim on return. */
    let lastPanel = CONVERSATION_ID

    function desktopBridge() {
      const carrier = globalThis.dshDesktop
      return carrier && carrier.protocolVersion === 1 && carrier.browser ? carrier.browser : undefined
    }

    function layout() {
      const service = appCtx && typeof appCtx.get === 'function' ? appCtx.get('layout') : undefined
      return service && typeof service.selectPanel === 'function' ? service : undefined
    }

    function selectPanel(id) {
      const service = layout()
      if (!service) return false
      try {
        service.selectPanel(id)
        return true
      } catch (error) {
        console.error('DeepSeek Switch: selectPanel(' + id + ') failed', error)
        return false
      }
    }

    function loadChatPage(element) {
      patch({ phase: 'loading', error: '' })
      try {
        const pending = element.loadURL(state.chatUrl)
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => {
            if (String(error && error.message).includes('ERR_ABORTED')) return
            patch({ phase: 'error', error: text(error) })
          })
        }
      } catch (error) {
        patch({ phase: 'error', error: text(error) })
      }
    }

    /* ---------------------------------------------------------------- session */

    /** True only on the official origin: every session operation is guarded by it. */
    function onChatOrigin(element) {
      try {
        return new URL(element.getURL()).origin === CHAT_ORIGIN
      } catch {
        return false
      }
    }

    /* Runs inside the guest: read the page's own localStorage and cookie string, minus the
       AWS WAF clearance entries, which belong to one challenge rather than to the login. */
    const READ_STATE =
      "(function () { if (location.origin !== '" + CHAT_ORIGIN + "') return null;"
      + " return JSON.stringify({ origin: location.origin,"
      + " storage: Object.keys(localStorage).filter(function (key) { return !/^(aws_waf|awswaf)/i.test(key) })"
      + "   .map(function (key) { return [key, localStorage.getItem(key)] }),"
      + " cookie: document.cookie.split(';').map(function (pair) { return pair.trim() })"
      + "   .filter(function (pair) { return pair && !/^aws-?waf-token=/i.test(pair) }).join('; ') }) })()"

    /* Runs inside the guest: write that state back. Cookies are re-scoped to the site root,
       which is where a login cookie belongs; `document.cookie` never carried their attributes. */
    function writeStateScript(restored) {
      return "(function () { if (location.origin !== '" + CHAT_ORIGIN + "') return false;"
        + " var state = " + JSON.stringify(restored) + ";"
        + " var storage = Array.isArray(state.storage) ? state.storage : [];"
        + " for (var i = 0; i < storage.length; i++) { if (/^(aws_waf|awswaf)/i.test(storage[i][0])) continue;"
        + "   try { localStorage.setItem(storage[i][0], storage[i][1]) } catch (error) {} }"
        + " if (typeof state.cookie === 'string' && state.cookie !== '') {"
        + "   var parts = state.cookie.split(';');"
        + "   for (var j = 0; j < parts.length; j++) { var pair = parts[j].trim();"
        + "     if (pair.indexOf('=') === -1) continue;"
        + "     try { document.cookie = pair + '; path=/' } catch (error) {} } }"
        + " return true })()"
    }

    /** Ask the host to put the saved session back before the page is first navigated. */
    async function sessionRestore(partition) {
      const reply = await rpc('session-restore', { partition })
      if (reply && typeof reply.session === 'object' && reply.session !== null) {
        patch({ session: reply.session })
      }
      const storage = reply && Array.isArray(reply.storage) ? reply.storage : []
      const cookie = reply && typeof reply.cookie === 'string' ? reply.cookie : ''
      patch({
        session: {
          ...state.session,
          electron: String((reply && reply.electron) || 'unknown'),
          savedAt: String((reply && reply.savedAt) || ''),
          cookies: Number((reply && reply.cookies) || 0),
        },
      })
      report('session-restore', {
        cookies: Number((reply && reply.cookies) || 0),
        storage: storage.length,
        error: String((reply && reply.error) || ''),
        electron: String((reply && reply.electron) || '').slice(0, 60),
      })
      if (storage.length === 0 && cookie === '') return null
      return { storage, cookie }
    }

    /**
     * Refresh the snapshot. `withState` ships what only the guest can read; the unload
     * beacon deliberately skips it and the host half then keeps the previous values.
     */
    async function saveSession(withState, record) {
      const target = record === undefined ? guest : record
      if (!target || !target.ready || !onChatOrigin(target.element)) return
      const body = { partition: target.partition }
      if (withState) {
        try {
          const raw = await target.element.executeJavaScript(READ_STATE)
          if (!target.ready || !onChatOrigin(target.element)) return
          const pageState = raw ? JSON.parse(raw) : null
          if (!pageState || pageState.origin !== CHAT_ORIGIN) return
          if (!Array.isArray(pageState.storage) || typeof pageState.cookie !== 'string') return
          body.storage = pageState.storage
          body.cookie = pageState.cookie
        } catch (error) {
          return
        }
      }
      try {
        const reply = await rpc('session-save', body)
        patch({
          session: {
            ...state.session,
            cookies: Number((reply && reply.cookies) || state.session.cookies),
            savedAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        console.warn('DeepSeek Switch: session save failed', error)
      }
    }

    /** Periodic snapshots plus the last-moment beacon; cleared when the guest goes away. */
    function startSessionTimers(record) {
      if (record.timer === undefined && saveIntervalMs > 0) {
        record.timer = setInterval(() => void saveSession(true, record), saveIntervalMs)
      }
      if (record.onUnload === undefined) {
        record.onUnload = () => {
          if (!record.ready || !onChatOrigin(record.element)) return
          try {
            navigator.sendBeacon(RPC, JSON.stringify({ op: 'session-save', partition: record.partition }))
          } catch {
            /* The page is going away. */
          }
        }
        window.addEventListener('beforeunload', record.onUnload)
      }
    }

    function stopSessionTimers(record) {
      if (record.timer !== undefined) clearInterval(record.timer)
      record.timer = undefined
      if (record.onUnload !== undefined) window.removeEventListener('beforeunload', record.onUnload)
      record.onUnload = undefined
      if (typeof record.unsubscribeOpen === 'function') {
        try {
          record.unsubscribeOpen()
        } catch {
          /* already gone */
        }
      }
      record.unsubscribeOpen = undefined
    }


    function ensureGuest(host) {
      if (guest && guest.element.isConnected) return Promise.resolve(guest)
      if (acquiring) return acquiring
      if (host === undefined || host === null) return Promise.resolve(undefined)
      const carrier = desktopBridge()
      if (carrier === undefined) {
        patch({ phase: 'error', error: '这个窗口没有桌面浏览器桥，请用系统浏览器打开' })
        return Promise.resolve(undefined)
      }
      acquiring = (async () => {
        try {
          const reservation = await carrier.acquire(WORKSPACE_KEY)
          /* Cookies must land on the partition before anything is requested from the site. */
          const restored = await sessionRestore(reservation.partition)
          const element = document.createElement('webview')
          element.className = 'dsx-guest'
          /* Same shape the shipped sidebar browser uses: main validates the lease, the
             partition and the about:blank#<lease> bootstrap address, then allows the attach. */
          element.dataset.sidebarBrowserFrame = 'webview'
          element.setAttribute('name', reservation.lease)
          element.setAttribute('partition', reservation.partition)
          element.setAttribute('allowpopups', '')
          element.setAttribute('src', 'about:blank#' + reservation.lease)
          /* The site greets a UA containing "electron" with its「使用环境异常」dialog, and its
             check is a literal substring test. Drop ONLY that token: the Chrome version and
             structure stay exactly as the engine reports them, so no fingerprint mismatch and
             no WAF challenge loop. */
          const userAgent = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
            ? navigator.userAgent.replace(/\s*Electron\/[\d.]+/i, '')
            : ''
          if (userAgent !== '') element.setAttribute('useragent', userAgent)
          const record = {
            element,
            lease: reservation.lease,
            carrier,
            partition: String(reservation.partition),
            ready: false,
            /* 'none' → nothing to restore; 'pending' → apply after the first load;
               'restoring' / 'reloading' → the one reload is in flight; 'done' → autosave on. */
            storageState: restored === null ? 'none' : 'pending',
          }
          element.addEventListener('dom-ready', () => {
            if (userAgent !== '') {
              try {
                element.setUserAgent(userAgent)
              } catch (error) {
                console.warn('DeepSeek Switch: could not set the guest user agent', error)
              }
            }
            loadChatPage(element)
          }, { once: true })
          element.addEventListener('did-start-loading', () => {
            record.ready = false
            patch({ phase: 'loading' })
          })
          element.addEventListener('did-finish-load', async () => {
            if (guest !== record || !onChatOrigin(element)) return
            if (record.storageState === 'pending' || record.storageState === 'restoring') {
              record.storageState = 'restoring'
              try {
                const applied = await element.executeJavaScript(writeStateScript(restored))
                if (guest !== record) return
                if (applied !== true || !onChatOrigin(element)) {
                  record.storageState = 'pending'
                  return
                }
                /* Storage and cookies can only be written while the page is on its own
                   origin, so the page is loaded once more — this time already signed in. */
                record.storageState = 'reloading'
                element.reload()
              } catch (error) {
                record.storageState = 'pending'
                console.warn('DeepSeek Switch: could not restore site storage', error)
              }
              return
            }
            record.storageState = 'done'
            record.ready = true
            startSessionTimers(record)
            void saveSession(true, record)
          })
          element.addEventListener('did-stop-loading', () => {
            if (state.phase !== 'error') patch({ phase: 'ready' })
          })
          element.addEventListener('did-fail-load', (event) => {
            if (!event.isMainFrame || event.errorCode === -3) return
            patch({ phase: 'error', error: (event.errorDescription || 'load failed') + ' (' + event.errorCode + ')' })
          })
          element.addEventListener('destroyed', () => {
            stopSessionTimers(record)
            guest = undefined
            patch({ phase: 'error', error: '网页进程已退出' })
          })
          /* Reply links pop windows through the lease-scoped native bridge; the shell opens
             http(s) targets in the system browser. */
          if (typeof carrier.onOpenRequested === 'function') {
            try {
              record.unsubscribeOpen = carrier.onOpenRequested(reservation.lease, (url) => {
                if (guest === record) openExternally(url)
              })
            } catch {
              /* an older bridge without the popup channel */
            }
          }
          guest = record
          host.appendChild(element)
          report('guest-attached', { partition: record.partition.slice(0, 22), url: state.chatUrl, restore: record.storageState })
          return guest
        } catch (error) {
          patch({ phase: 'error', error: text(error) })
          report('guest-failed', { message: text(error) })
          return undefined
        } finally {
          acquiring = undefined
        }
      })()
      return acquiring
    }

    /* -------------------------------------------------------------------- css */

    const CSS = `
.dsx-surface { position: absolute; bottom: 0; left: var(--dsx-left, 0px); right: var(--dsx-right, 0px);
  top: var(--dsx-top, 0px); display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base); }
.dsx-surface[data-on="0"] { opacity: 0; visibility: hidden; pointer-events: none; }
.dsx-body { position: relative; flex: 1 1 auto; min-height: 0; }
.dsx-guest { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: flex;
  background: transparent; }
.dsx-holder { height: 100%; }
.dsx-progress { position: absolute; top: 0; left: 0; right: 0; height: 2px; z-index: 2;
  background: var(--dsw-alias-brand-primary); opacity: .75;
  animation: dsx-slide 1.1s ease-in-out infinite; transform-origin: 0 50%; }
@keyframes dsx-slide { 0% { transform: scaleX(.1) } 50% { transform: scaleX(.75) } 100% { transform: scaleX(.1) } }
.dsx-error { position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%);
  max-width: 420px; padding: 16px 18px; border-radius: 10px; text-align: center;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dsx-error-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsx-error-text { margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary);
  word-break: break-word; }
.dsx-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: center; }
.dsx-btn { height: 26px; padding: 0 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); }
.dsx-btn:hover { background: var(--dsw-alias-bg-overlay); }
.dsx-btn[data-primary="1"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsx-glyph { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
`

    /* ------------------------------------------------------------- components */

    /**
     * The sidebar entry. Clicking it falls through to the native panel selection (which is how
     * Chat is entered); clicking it again while Chat is active returns to the previous panel.
     */
    function ChatEntry(props) {
      const size = (props && props.size) || 16
      const active = !!(props && props.active)
      const box = React.useRef(null)
      React.useEffect(() => {
        /* Self-check hook: the glyph's measured box, recorded once, so the row a click actually
           lands on can be identified from diagnostics instead of guessed. */
        const node = box.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        const rect = node.getBoundingClientRect()
        report('entry-rect', {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          dpr: window.devicePixelRatio,
        })
      }, [])
      return h(
        'span',
        {
          className: 'dsx-glyph',
          ref: box,
          title: active ? '返回 Harness' : '打开 DeepSeek Chat',
          onClick: active
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                /* Deferred so that a native selection handler, if it still runs on this same
                   click, cannot win: the Harness selection always lands last. */
                setTimeout(() => enterHarness(), 0)
              }
            : undefined,
        },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M2.5 5.2A2.2 2.2 0 0 1 4.7 3h6.6a2.2 2.2 0 0 1 2.2 2.2v3.6a2.2 2.2 0 0 1-2.2 2.2H7.6L4.4 13.3v-2.3H4.7a2.2 2.2 0 0 1-2.2-2.2z',
            stroke: 'currentColor',
            'stroke-width': '1.3',
            'stroke-linejoin': 'round',
          }),
        ),
      )
    }

    /**
     * The overlay surface: the official page, nothing else. No plugin title bar, no status
     * text — the only drawn chrome is a loading hairline and an error card that exists solely
     * when the page could not load.
     */
    function ChatSurface(props) {
      const snapshot = useSnapshot()
      const holder = React.useRef(null)
      const root = React.useRef(null)
      const usePanelInfo = props && typeof props.usePanelInfo === 'function' ? props.usePanelInfo : () => undefined
      const activePanelId = usePanelInfo((info) => (info ? info.activePanelId : undefined))

      React.useEffect(() => {
        hostElement = holder.current || undefined
        if (hostElement) void ensureGuest(hostElement)
      }, [])

      React.useEffect(() => {
        if (typeof activePanelId === 'string' && activePanelId !== PANEL_ID) lastPanel = activePanelId
      }, [activePanelId])

      React.useEffect(() => {
        /* ponytail: the frame is a `sidebar | main | rightbar` grid, so its computed column
           tracks ARE the columns we must not cover. Ceiling: a frame that stops being a grid
           leaves the surface full-bleed. Upgrade path: a layout-service geometry API, if one
           ever appears. Observed instead of only listening to resize, because collapsing the
           sidebar changes the tracks without a window resize. */
        const centre = root.current
        if (!centre) return
        let frame
        let raf = 0
        let reported = false
        const frameOf = () => {
          /* The overlay host sits somewhere under the layout frame; find the nearest grid
             ancestor instead of assuming a fixed depth (the slot renderer may wrap entries). */
          let node = centre.parentElement
          let top = 0
          let grid
          while (node && node !== document.body) {
            const computed = getComputedStyle(node)
            if (computed.paddingTop) {
              const value = parseFloat(computed.paddingTop) || 0
              if (value > top) top = value
            }
            if (!grid && computed.display === 'grid' && computed.gridTemplateColumns !== 'none') grid = node
            node = node.parentElement
          }
          return { grid, top }
        }
        const measure = () => {
          raf = 0
          if (!centre) return
          try {
            const found = frameOf()
            const computed = found.grid ? getComputedStyle(found.grid) : undefined
            const tracks = computed
              ? computed.gridTemplateColumns
                  .split(' ')
                  .map((value) => parseFloat(value))
                  .filter((value) => Number.isFinite(value))
              : []
            const left = tracks[0] || 0
            const right = tracks.length > 2 ? tracks.slice(2).reduce((sum, value) => sum + value, 0) : 0
            /* The frame's top padding IS the native titlebar band (its ::before drag strip has
               exactly that height), so the surface starts below it and the window controls stay
               uncovered and draggable. 0 on platforms without an overlay titlebar. */
            centre.style.setProperty('--dsx-left', left + 'px')
            centre.style.setProperty('--dsx-right', right + 'px')
            centre.style.setProperty('--dsx-top', found.top + 'px')
            if (!reported) {
              reported = true
              report('geometry', {
                top: found.top,
                left,
                right,
                tracks: tracks.length,
                grid: found.grid ? found.grid.className.slice(0, 40) : '(none)',
              })
            }
          } catch {
            centre.style.setProperty('--dsx-left', '0px')
            centre.style.setProperty('--dsx-right', '0px')
            centre.style.setProperty('--dsx-top', '0px')
          }
        }
        const schedule = () => {
          if (raf) return
          raf = requestAnimationFrame(measure)
        }
        frame = centre.parentElement && centre.parentElement.parentElement
        const observed = frameOf().grid || frame
        measure()
        window.addEventListener('resize', schedule)
        const observer = observed && typeof MutationObserver === 'function'
          ? new MutationObserver(schedule)
          : undefined
        if (observer) observer.observe(observed, { attributes: true, attributeFilter: ['style', 'class'] })
        return () => {
          window.removeEventListener('resize', schedule)
          if (observer) observer.disconnect()
          if (raf) cancelAnimationFrame(raf)
        }
      }, [])

      const reload = () => {
        if (guest) loadChatPage(guest.element)
        else void ensureGuest(hostElement)
      }

      return h(
        'div',
        {
          className: 'dsx-surface',
          ref: root,
          'data-on': snapshot.mode === MODES.chat ? '1' : '0',
          'aria-hidden': snapshot.mode === MODES.chat ? undefined : 'true',
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsx-body', ref: holder },
          snapshot.phase === 'loading' ? h('div', { className: 'dsx-progress' }) : null,
          snapshot.phase === 'error'
            ? h(
                'div',
                { className: 'dsx-error', role: 'alert' },
                h('div', { className: 'dsx-error-title' }, '官方页面没有打开'),
                h('div', { className: 'dsx-error-text' }, snapshot.error || '未知错误'),
                h(
                  'div',
                  { className: 'dsx-actions' },
                  h('button', { className: 'dsx-btn', onClick: reload }, '重试'),
                  h('button', { className: 'dsx-btn', onClick: openExternally }, '浏览器打开'),
                  h('button', { className: 'dsx-btn', 'data-primary': '1', onClick: () => enterHarness() }, '返回 Harness'),
                ),
              )
            : null,
        ),
      )
    }

    /**
     * The Chat main panel. Holding the layout's selection is its whole job: selected ⇒ Chat,
     * deselected (a native session row, 新会话, any other entry) ⇒ back to Harness.
     */
    function ChatPanel(props) {
      const usePanelInfo = props && typeof props.usePanelInfo === 'function' ? props.usePanelInfo : () => undefined
      const activePanelId = usePanelInfo((info) => (info ? info.activePanelId : undefined))

      React.useEffect(() => {
        if (state.mode !== MODES.chat) enterChat()
        return () => {
          if (state.mode !== MODES.chat) return
          patch({ mode: MODES.harness })
          void rpc('write', { mode: MODES.harness }).catch(() => {})
        }
      }, [])

      React.useEffect(() => {
        if (activePanelId === undefined) return
        if (activePanelId !== PANEL_ID && state.mode === MODES.chat) enterHarness(false)
      }, [activePanelId])

      return h('div', { className: 'dsx-holder' })
    }

    /* ------------------------------------------------------------------- host */

    async function rpc(op, payload) {
      const response = await fetch(RPC, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload || {}) }),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    /** Fire-and-forget diagnostic line: proof in diag.ndjson that a phase really ran. */
    function report(stage, extra) {
      void rpc('diag', { entry: { stage, ...(extra || {}) } }).catch(() => {})
    }

    async function persist() {
      try {
        await rpc('write', { mode: state.mode })
        if (!state.persists) patch({ persists: true })
      } catch (error) {
        if (state.persists) patch({ persists: false })
        console.error('DeepSeek Switch: mode persistence failed', error)
      }
    }

    function enterChat() {
      if (state.mode !== MODES.chat) patch({ mode: MODES.chat })
      report('enter-chat', { via: 'enterChat' })
      /* The panel registry syncs a tick after the sidebar list registration lands, so a boot-time
         selection can miss once. One short retry is enough; the overlay works either way. */
      if (!selectPanel(PANEL_ID)) setTimeout(() => selectPanel(PANEL_ID), 120)
      void ensureGuest(hostElement)
    }

    /**
     * Return to the Harness workspace by re-selecting the panel that was open before Chat.
     * It never calls startSession and never creates a session: the conversation, its workspace
     * and its running agent are untouched by the round trip.
     */
    function enterHarness(restore) {
      if (state.mode !== MODES.harness) patch({ mode: MODES.harness })
      const panel = restore === false ? undefined : lastPanel || CONVERSATION_ID
      if (panel !== undefined) {
        if (!selectPanel(panel)) selectPanel(CONVERSATION_ID)
      }
      report('return-harness', { panel: panel || '(native navigation)' })
      void persist()
    }

    function openExternally(target) {
      /* The Electron shell opens http(s) targets in the system browser. */
      const url = typeof target === 'string' && /^https?:\/\//i.test(target) ? target : state.chatUrl
      window.open(url, '_blank', 'noopener')
    }

    /* ------------------------------------------------------------------ apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        appCtx = ctx

        ctx.effect(() => {
          let live = true
          void (async () => {
            try {
              const reply = await rpc('read', {})
              if (!live || !reply || !reply.ok) return
              const saved = reply.state || {}
              const url = typeof saved.chatUrl === 'string' && saved.chatUrl ? saved.chatUrl : DEFAULT_CHAT_URL
              const restored = saved.autoRestore === false ? MODES.harness : saved.mode === MODES.chat ? MODES.chat : MODES.harness
              patch({
                chatUrl: url,
                persists: true,
                session: {
                  electron: String((saved.session && saved.session.electron) || 'unknown'),
                  savedAt: String((saved.session && saved.session.saved && saved.session.saved.savedAt) || ''),
                  cookies: Number((saved.session && saved.session.saved && saved.session.saved.cookies) || 0),
                },
              })
              if (typeof saved.saveIntervalMs === 'number' && saved.saveIntervalMs >= 0) {
                saveIntervalMs = saved.saveIntervalMs
              }
              report('client-boot', {
                restored,
                persisted: saved.persisted === true,
                snapshot: state.session.savedAt || '(none)',
                cookies: state.session.cookies,
                electron: state.session.electron.slice(0, 60),
              })
              if (restored === MODES.chat) enterChat()
            } catch (error) {
              patch({ persists: false })
              console.error('DeepSeek Switch: host half unreachable', error)
            }
          })()
          return () => {
            live = false
          }
        }, 'deepseek-switch:boot')

        ctx.effect(() => {
          const onKey = (event) => {
            if (!event.altKey || event.ctrlKey || event.metaKey) return
            if (event.key === '1') {
              event.preventDefault()
              enterChat()
            } else if (event.key === '2') {
              event.preventDefault()
              enterHarness()
            }
          }
          window.addEventListener('keydown', onKey, true)
          return () => window.removeEventListener('keydown', onKey, true)
        }, 'deepseek-switch:shortcuts')

        /* The surface holds the persistent guest page and is mounted once for the app's life. */
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'deepseek-switch-chat' }, ChatSurface),
        )
        /* The single switch entry: a native nav row under 新会话, above 插件. */
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: -1000, label: 'Chat' }, ChatEntry),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, ChatPanel))

        /* Plugin disposal: last chance to keep the login, then let the lease go. */
        ctx.effect(() => () => {
          const record = guest
          guest = undefined
          if (!record) return
          stopSessionTimers(record)
          void saveSession(true, record)
          try {
            record.carrier.release(record.lease)
          } catch {
            /* already gone */
          }
          if (record.element.isConnected) record.element.remove()
        }, 'deepseek-switch:guest')
      },
    }
  },
})



