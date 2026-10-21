/**
 * Host half of the DeepSeek Switch bundle.
 *
 * Three jobs:
 *   1. persist the selected mode under $DSH_HOME — the Web origin's port changes on
 *      every launch, so the page cannot use localStorage for that;
 *   2. keep the DeepSeek login alive across restarts. The shell hands every browser
 *      guest a **process-lifetime** partition (`dsh-sidebar-browser-<uuid>`, no
 *      `persist:` prefix), so cookies die with the app. This half runs inside the
 *      Electron main process — the only place that can read a partition's cookies,
 *      HttpOnly ones included — so it snapshots them to a user-private file and puts
 *      them back before the page is first navigated. Site storage and the page's own
 *      `document.cookie` string, which a renderer can reach, are carried by the
 *      client half through the same route;
 *   3. answer that tiny same-origin RPC and keep a bounded diagnostics ledger.
 *
 * Snapshot scope: cookies whose domain is deepseek.com only, minus the AWS WAF
 * clearance token (that belongs to the challenge that minted it, not to the login).
 *
 * Follows the design of `@jaychang1989/dsh-webchat` 0.7.8 (Apache-2.0) — the
 * Electron-session snapshot, the restore-before-navigate order, the empty-page
 * autosave guard and the WAF filtering all come from there. See README §10.
 */
import { mkdir, readFile, rename, writeFile, appendFile, copyFile, realpath, rm, rmdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-deepseek-switch/rpc'
/* Generous because a session save carries the page's localStorage; still bounded. */
const MAX_BODY = 512 * 1024
const DEFAULT_CHAT_URL = 'https://chat.deepseek.com/'
const MODES = new Set(['chat', 'harness'])
/* A partition name the shell issues for a browser guest, and nothing else. */
const GUEST_PARTITION = /^dsh-sidebar-browser-[0-9a-f-]{8,}$/
const SNAPSHOT_VERSION = 1

/** CommonJS require anchored here: Electron serves `electron` to CJS natively. */
const requireHere = createRequire(import.meta.url)

const text = (error) => (error && error.message ? error.message : String(error))

/**
 * The harness home, resolved the way the harness itself resolves it: `$DSH_HOME`
 * when set to a non-blank value, otherwise `~/.dsh`.
 */
function dshHome(env = process.env) {
  const raw = env.DSH_HOME
  const override = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  return override === undefined ? join(homedir(), '.dsh') : override
}

const stateDir = () => join(dshHome(), 'dsh-deepseek-switch')

/* ------------------------------------------------------------------ electron */

/** Electron reachability, probed once; reported through the state view. */
let electronStatus = 'unknown'

/** Overridable Electron lookup: the tests drive the snapshot logic without Electron. */
let electronLoader = null

/** Point the snapshot somewhere else. Test seam; production leaves it unset. */
let sessionFilePath = null

export function setElectronLoader(loader) {
  electronLoader = loader
}

export function setSessionFile(path) {
  sessionFilePath = path
}

/**
 * Load Electron two ways, because the harness's ESM loader resolves bare specifiers
 * itself and does not always hand `electron` to Electron's own resolver, while a
 * CommonJS require is what Electron serves natively.
 */
async function electronApi() {
  if (electronLoader !== null) return electronLoader()
  const usable = (mod) => {
    if (mod === null || typeof mod !== 'object') return undefined
    if (mod.session !== undefined || mod.BrowserWindow !== undefined) return mod
    const inner = mod.default
    if (inner !== null && typeof inner === 'object'
      && (inner.session !== undefined || inner.BrowserWindow !== undefined)) return inner
    return undefined
  }
  const failures = []
  try {
    const fromImport = usable(await import('electron'))
    if (fromImport !== undefined) return fromImport
    failures.push('esm import exposed no session API')
  } catch (error) {
    failures.push('esm import failed: ' + text(error))
  }
  try {
    const fromRequire = usable(requireHere('electron'))
    if (fromRequire !== undefined) return fromRequire
    failures.push('cjs require exposed no session API')
  } catch (error) {
    failures.push('cjs require failed: ' + text(error))
  }
  throw new Error(failures.join(' | '))
}

/** Probe Electron once for diagnostics; never throws. */
async function electronProbe() {
  try {
    const electron = await electronApi()
    electronStatus = electron.session === undefined ? 'no session API' : 'ready'
  } catch (error) {
    electronStatus = text(error)
  }
  return electronStatus
}

/**
 * The live session of a guest partition. Validates the partition name first: this
 * half must never touch a session the shell did not hand out for a browser guest.
 */
async function partitionSession(partition) {
  if (!GUEST_PARTITION.test(partition)) throw new Error('not a browser-guest partition')
  const electron = await electronApi()
  if (electron.session === undefined) throw new Error('this process exposes no Electron session API')
  return electron.session.fromPartition(partition)
}

/* ------------------------------------------------------------------ snapshot */

/** Only DeepSeek cookies belong in this snapshot; never another site's credentials. */
function isDeepSeekCookie(cookie) {
  if (cookie === null || typeof cookie !== 'object' || typeof cookie.domain !== 'string') return false
  const domain = cookie.domain.replace(/^\./, '').toLowerCase()
  return domain === 'deepseek.com' || domain.endsWith('.deepseek.com')
}

/** The AWS WAF clearance cookie tracks one challenge, not the login. */
const isWafCookie = (entry) => /^aws-?waf-token$/i.test(entry && entry.name)
const isWafKey = (key) => /^(aws_waf|awswaf)/i.test(String(key))

/**
 * Read the snapshot. A corrupt file reads as null and is left untouched on disk, so a
 * failed restore can never destroy the last good copy.
 */
export async function readSnapshot(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      storage: Array.isArray(parsed.storage) ? parsed.storage : [],
      /* The page's own `document.cookie`, which cannot carry HttpOnly cookies — it is
         what still works when this process has no Electron session API at all. */
      cookie: typeof parsed.cookie === 'string' ? parsed.cookie : '',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    }
  } catch {
    return null
  }
}

/** Write the snapshot atomically, user-private, so a crash cannot truncate it. */
async function writeSnapshot(file, snapshot) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file)
}

/** Serialize a partition's cookies, HttpOnly included. */
export async function captureCookies(cookies) {
  const list = await cookies.get({})
  return list
    .filter(isDeepSeekCookie)
    .filter((cookie) => !isWafCookie(cookie))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(typeof cookie.expirationDate === 'number' ? { expirationDate: cookie.expirationDate } : {}),
      ...(typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite } : {}),
    }))
}

/** Put saved cookies back on a partition's session; returns how many it accepted. */
export async function restoreCookies(cookies, snapshot) {
  let restored = 0
  for (const cookie of snapshot.cookies) {
    if (!isDeepSeekCookie(cookie) || isWafCookie(cookie)) continue
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue
    const domain = typeof cookie.domain === 'string' ? cookie.domain : ''
    if (domain === '') continue
    const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/'
    const details = {
      url: `${cookie.secure === true ? 'https' : 'http'}://${domain.replace(/^\./, '')}${path}`,
      name: cookie.name,
      value: cookie.value,
      domain,
      path,
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
    }
    if (typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate
    if (typeof cookie.sameSite === 'string') details.sameSite = cookie.sameSite
    try {
      await cookies.set(details)
      restored += 1
    } catch {
      /* A cookie the running Electron refuses (bad domain, expired, …) must not fail
         the whole restore: the rest of the login still has to come back. */
    }
  }
  return restored
}

/* ------------------------------------------------------- registration hygiene */

/**
 * The profile manifest this process runs from: `$DSH_HOME/profiles/<profile>/package.json`,
 * where `<profile>` is what the launcher exported as `DSH_PROFILE` (the desktop app uses
 * `desktop`).
 */
export function profileManifestPath(env = process.env) {
  const raw = env.DSH_PROFILE
  const profile = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'desktop'
  return join(dshHome(env), 'profiles', profile, 'package.json')
}

async function resolvesTo(directory, target) {
  try {
    return (await realpath(directory)) === (await realpath(target))
  } catch {
    return false
  }
}

/**
 * Collapse a duplicate registration of THIS package in one profile manifest.
 *
 * Why this exists: a bundle is recorded in the profile by package name, so installing from a
 * directory *before* the package was renamed left the profile holding both names
 * (`@local/dsh-deepseek-switch` and `dsh-deepseek-switch`) pointing at the same directory.
 * The bundle list is what the loader composes, so one directory was composed twice, both
 * copies declared the same `- id: deepseek-switch`, and every composition check failed with
 * `duplicate loader entry id "deepseek-switch" (2 rows)` — which rolled back unrelated
 * plugin updates and listed this plugin twice.
 *
 * Safety: an entry is removed only when the directory it installs from resolves to *this*
 * package's own directory, so another plugin's record can never be touched, and the
 * canonical name (this package's own `name`) is always kept. A second run is a no-op, the
 * original manifest is kept beside it as `package.json.bak-<timestamp>`, and the write is a
 * temp file plus rename so a crash cannot leave a half-written profile.
 */
export async function deduplicateRegistration({ manifestPath, ownDir } = {}) {
  const outcome = { changed: false, kept: '', removed: [], backup: '', error: '' }
  if (typeof manifestPath !== 'string' || manifestPath === '' || typeof ownDir !== 'string' || ownDir === '') {
    return { ...outcome, error: 'missing-arguments' }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return outcome
  }
  if (manifest === null || typeof manifest !== 'object') return outcome
  let ownName = ''
  try {
    ownName = String(JSON.parse(await readFile(join(ownDir, 'package.json'), 'utf8')).name || '')
  } catch {
    return { ...outcome, error: 'own-name-unreadable' }
  }
  if (ownName === '') return { ...outcome, error: 'own-name-missing' }

  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)
    ? manifest.dependencies
    : {}
  const declared = manifest.dsh !== null && typeof manifest.dsh === 'object'
    && manifest.dsh.profile !== null && typeof manifest.dsh.profile === 'object'
    && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const bundles = declared.filter((name) => typeof name === 'string')
  const profileDirectory = dirname(manifestPath)

  const names = new Set([...Object.keys(dependencies), ...bundles])
  const duplicate = []
  for (const name of names) {
    if (name === ownName) continue
    if (await resolvesTo(join(profileDirectory, 'node_modules', name), ownDir)) duplicate.push(name)
  }
  outcome.kept = ownName
  if (duplicate.length === 0) return outcome

  const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await copyFile(manifestPath, backup)
  } catch {
    return { ...outcome, error: 'backup-failed' }
  }
  for (const name of duplicate) {
    delete dependencies[name]
    for (let index = declared.length - 1; index >= 0; index -= 1) {
      if (declared[index] === name) declared.splice(index, 1)
    }
    await rm(join(profileDirectory, 'node_modules', name), { recursive: true, force: true })
  }
  try {
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rename(`${manifestPath}.tmp`, manifestPath)
  } catch {
    return { ...outcome, error: 'write-failed', backup }
  }
  try {
    /* Only the alias scope this duplicate lived in; a non-empty scope stays. */
    await rmdir(join(profileDirectory, 'node_modules', '@local'))
  } catch {
    // Still holds other packages: leave it alone.
  }
  return { changed: true, kept: ownName, removed: duplicate, backup, error: '' }
}

/* --------------------------------------------------------------------- apply */

/**
 * Wait for the Web server service before applying. Cordis `inject` is a plain array of
 * service names in this version; the object form (`{required, optional}`) never resolves
 * and leaves the row `pending` forever, so `apply` never runs and no route is registered.
 * Same shape the shipped third-party bundles use: `export const inject = ['llm', 'webServer']`
 * (dsh-prompt-enhance/lib/index.js:984).
 */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const dir = stateDir()
  const stateFile = join(dir, 'state.json')
  const diagFile = join(dir, 'diag.ndjson')
  const snapshotFile = () => sessionFilePath === null ? join(dir, 'session.json') : sessionFilePath

  const settings = {
    chatUrl: typeof config.chatUrl === 'string' && config.chatUrl ? config.chatUrl : DEFAULT_CHAT_URL,
    autoRestore: config.autoRestore !== false,
    defaultMode: MODES.has(config.defaultMode) ? config.defaultMode : 'harness',
    /* Bounded autosave cadence the client half uses; 0 disables periodic snapshots. */
    saveIntervalMs: Number.isFinite(config.saveIntervalMs) && config.saveIntervalMs >= 0
      ? Math.min(Math.round(config.saveIntervalMs), 600000)
      : 30000,
  }

  const state = {
    mode: settings.defaultMode,
    updatedAt: 0,
    persisted: false,
  }

  /* Outcome of the profile-registration check, reported through the state view. */
  const registration = { checked: false, changed: false, kept: '', removed: [], error: '' }

  const ready = (async () => {
    try {
      await mkdir(dir, { recursive: true })
      const saved = JSON.parse(await readFile(stateFile, 'utf8'))
      if (saved && typeof saved === 'object') {
        if (MODES.has(saved.mode)) state.mode = saved.mode
        if (typeof saved.updatedAt === 'number') state.updatedAt = saved.updatedAt
        state.persisted = true
      }
    } catch {
      // First run, or an unreadable file: keep the configured default.
    }
  })()

  const persist = async () => {
    state.updatedAt = Date.now()
    await mkdir(dir, { recursive: true })
    const temp = `${stateFile}.tmp`
    await writeFile(temp, `${JSON.stringify({ mode: state.mode, updatedAt: state.updatedAt }, null, 2)}\n`, 'utf8')
    await rename(temp, stateFile)
    state.persisted = true
  }

  const diag = async (entry) => {
    try {
      await mkdir(dir, { recursive: true })
      await appendFile(diagFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      // Diagnostics must never break the feature.
    }
  }

  /** Counts and paths only: no cookie or token value ever leaves the snapshot file. */
  const sessionView = (snapshot) => ({
    file: snapshotFile(),
    electron: electronStatus,
    saved: snapshot === null ? null : {
      cookies: snapshot.cookies.length,
      storage: snapshot.storage.length,
      cookie: snapshot.cookie !== '',
      savedAt: snapshot.savedAt,
    },
  })

  const view = (snapshot) => ({
    mode: state.mode,
    updatedAt: state.updatedAt,
    persisted: state.persisted,
    chatUrl: settings.chatUrl,
    autoRestore: settings.autoRestore,
    saveIntervalMs: settings.saveIntervalMs,
    stateFile,
    session: sessionView(snapshot),
    registration,
  })

  const json = (res, code, value) => {
    if (res.headersSent) return
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  /* Local-service trust boundary: this route is reachable only from a loopback caller,
     the body is capped, the method is POST-only and `Origin` must be the Harness shell
     or this very server. That stops a random web page (or a DNS-rebinding fetch) from
     rewriting the stored mode or reading the session snapshot. The snapshot route
     additionally accepts only a partition name the shell issues for a browser guest. */
  const originAllowed = (req) => {
    const origin = req.headers.origin
    if (origin === undefined || origin === '' || origin === 'null') return true
    const allowed = new Set(['dsh-app://app'])
    try {
      if (webServer && typeof webServer.getOrigin === 'function') {
        const self = webServer.getOrigin()
        if (typeof self === 'string' && self) allowed.add(new URL(self).origin)
      }
    } catch {
      // An unrecognized advertised origin only tightens the check.
    }
    return allowed.has(origin)
  }

  /** Restore cookies onto the guest's partition, then hand the page state back. */
  const sessionRestore = async (payload) => {
    const partition = typeof payload.partition === 'string' ? payload.partition : ''
    if (!GUEST_PARTITION.test(partition)) return { code: 400, value: { ok: false, error: 'not-a-guest-partition' } }
    const file = snapshotFile()
    const snapshot = await readSnapshot(file)
    if (snapshot === null) {
      return { code: 200, value: { ok: true, cookies: 0, storage: [], cookie: '', savedAt: '', electron: electronStatus } }
    }
    let restored = 0
    let error = ''
    try {
      const session = await partitionSession(partition)
      restored = await restoreCookies(session.cookies, snapshot)
    } catch (failure) {
      /* Without a session API the HttpOnly cookies cannot come back; site storage and
         the page's own cookie string still can, so this is reported, not fatal. */
      error = text(failure)
      electronStatus = electronStatus === 'ready' ? electronStatus : error
    }
    await diag({ stage: 'session-restore', partition: partition.slice(0, 24), cookies: restored, error })
    return {
      code: 200,
      value: {
        ok: error === '',
        error,
        cookies: restored,
        storage: snapshot.storage,
        cookie: snapshot.cookie,
        savedAt: snapshot.savedAt,
        electron: electronStatus,
      },
    }
  }

  /** Refresh the snapshot: partition cookies from Electron, page state from the caller. */
  const sessionSave = async (payload) => {
    const partition = typeof payload.partition === 'string' ? payload.partition : ''
    if (!GUEST_PARTITION.test(partition)) return { code: 400, value: { ok: false, error: 'not-a-guest-partition' } }
    const file = snapshotFile()
    const previous = await readSnapshot(file)
    /* A save without site storage (the unload beacon) must not erase what an earlier
       save captured. */
    const storage = Array.isArray(payload.storage)
      ? payload.storage.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && !isWafKey(entry[0]))
      : (previous === null ? [] : previous.storage)
    const cookie = typeof payload.cookie === 'string'
      ? payload.cookie.split(';').map((pair) => pair.trim()).filter((pair) => pair !== '' && !/^aws-?waf-token=/i.test(pair)).join('; ')
      : (previous === null ? '' : previous.cookie)
    let cookies = previous === null ? [] : previous.cookies
    let error = ''
    try {
      const session = await partitionSession(partition)
      cookies = await captureCookies(session.cookies)
    } catch (failure) {
      error = text(failure)
      electronStatus = electronStatus === 'ready' ? electronStatus : error
    }
    await writeSnapshot(file, {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      cookies,
      storage,
      cookie,
    })
    await diag({ stage: 'session-save', partition: partition.slice(0, 24), cookies: cookies.length, storage: storage.length, error })
    return { code: 200, value: { ok: true, cookies: cookies.length, storage: storage.length, cookie: cookie !== '', error } }
  }

  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!originAllowed(req)) {
        await diag({ stage: 'auth', origin: req.headers.origin })
        return json(res, 403, { ok: false, error: 'forbidden-origin' })
      }
      let payload = {}
      try {
        const body = await readBody(req)
        payload = body ? JSON.parse(body) : {}
      } catch {
        return json(res, 400, { ok: false, error: 'bad-request-body' })
      }
      await ready
      switch (payload.op) {
        case 'read': {
          const snapshot = await readSnapshot(snapshotFile())
          return json(res, 200, { ok: true, state: view(snapshot) })
        }
        case 'write': {
          if (MODES.has(payload.mode)) state.mode = payload.mode
          await persist()
          await diag({ stage: 'write', mode: state.mode, persisted: state.persisted })
          return json(res, 200, { ok: true, state: view(await readSnapshot(snapshotFile())) })
        }
        case 'diag': {
          const entry = payload.entry && typeof payload.entry === 'object' ? payload.entry : { note: String(payload.entry) }
          await diag({ source: 'client', ...entry })
          return json(res, 200, { ok: true })
        }
        case 'session-state': {
          const snapshot = await readSnapshot(snapshotFile())
          return json(res, 200, { ok: true, session: sessionView(snapshot) })
        }
        case 'session-restore': {
          const result = await sessionRestore(payload)
          return json(res, result.code, result.value)
        }
        case 'session-save': {
          const result = await sessionSave(payload)
          return json(res, result.code, result.value)
        }
        default:
          return json(res, 400, { ok: false, error: 'unknown-op' })
      }
    } catch (error) {
      await diag({ stage: 'handler', message: text(error) })
      return json(res, 500, { ok: false, error: text(error) })
    }
  }

  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    void diag({ stage: 'apply', message: 'webServer unavailable; mode persistence disabled' })
    return
  }

  ctx.effect(
    () => webServer.register({ kind: 'exact', path: ROUTE, handler }),
    'deepseek-switch:rpc',
  )
  /* One idempotent pass over the profile's own registration records, so a leftover alias of
     this same package cannot keep composing twice (see deduplicateRegistration). Runs after
     the route exists, never blocks the server, and reports through diag + the state view. */
  void ready
    .then(() => deduplicateRegistration({
      manifestPath: profileManifestPath(),
      ownDir: dirname(fileURLToPath(import.meta.url)),
    }))
    .then(async (outcome) => {
      Object.assign(registration, { checked: true }, outcome)
      await diag({ stage: 'registration', ...outcome })
    })
    .catch((error) => {
      registration.error = text(error)
    })

  void electronProbe().then((status) => diag({
    stage: 'apply',
    route: ROUTE,
    stateFile,
    sessionFile: snapshotFile(),
    electron: status,
    settings,
  }))
}
