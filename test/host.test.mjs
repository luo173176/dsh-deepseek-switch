/**
 * Host-half checks. No framework: `node test/host.test.mjs`.
 *
 * Runs the real `apply()` against a stub Cordis context and a real HTTP server,
 * so the body streaming, the local-service origin gate, the JSON replies and the
 * on-disk state file are exercised end to end. The framework wiring around it (row
 * insertion by the loader, the real `ctx.effect` disposer, the injected `webServer`)
 * is not covered here and is listed as 待验证 in README.md.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = await mkdtemp(join(tmpdir(), 'dss-test-'))
process.env.DSH_HOME = home

const { apply, setElectronLoader } = await import('../index.js')

const ROUTE = '/dsh-deepseek-switch/rpc'

function mount() {
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register: (route) => (routes.push(route), () => {}),
          getOrigin: () => 'http://127.0.0.1:49823',
        }
      }
      return undefined
    },
    effect(callback) {
      return callback()
    },
  }
  apply(ctx, { chatUrl: 'https://chat.deepseek.com/', defaultMode: 'harness', autoRestore: true })
  assert.equal(routes.length, 1, 'exactly one route is registered')
  assert.equal(routes[0].path, ROUTE)
  assert.equal(routes[0].kind, 'exact')
  return routes[0]
}

async function listen(route) {
  const server = createServer((req, res) => void route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}${ROUTE}`, close: () => new Promise((r) => server.close(r)) }
}

const post = async (base, body, headers = {}) => {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// 1. A fresh install reads the configured default and is not persisted yet.
{
  const server = await listen(mount())
  const read = await post(server.base, { op: 'read' })
  assert.equal(read.status, 200)
  assert.equal(read.body.state.mode, 'harness')
  assert.equal(read.body.state.persisted, false)
  assert.equal(read.body.state.chatUrl, 'https://chat.deepseek.com/')
  await server.close()
  console.log('ok 1 - fresh install answers with the configured default')
}

// 2. Writing the mode lands in the state file.
{
  const server = await listen(mount())
  const written = await post(server.base, { op: 'write', mode: 'chat' })
  assert.equal(written.status, 200)
  assert.equal(written.body.state.mode, 'chat')
  assert.equal(written.body.state.persisted, true)
  const saved = JSON.parse(await readFile(join(home, 'dsh-deepseek-switch', 'state.json'), 'utf8'))
  assert.equal(saved.mode, 'chat')
  assert.equal(typeof saved.updatedAt, 'number')
  await server.close()
  console.log('ok 2 - the selected mode is written to state.json')
}

// 3. A second apply() — the restart path — restores what was written.
{
  const server = await listen(mount())
  const read = await post(server.base, { op: 'read' })
  assert.equal(read.body.state.mode, 'chat')
  assert.equal(read.body.state.persisted, true)
  await server.close()
  console.log('ok 3 - a restarted host half restores the saved mode')
}

// 4. The shell and this server may write; any other browser origin may not.
{
  const server = await listen(mount())
  const fromShell = await post(server.base, { op: 'write', mode: 'harness' }, { origin: 'dsh-app://app' })
  assert.equal(fromShell.status, 200)
  const fromServer = await post(server.base, { op: 'write', mode: 'harness' }, { origin: 'http://127.0.0.1:49823' })
  assert.equal(fromServer.status, 200)
  const hostile = await post(server.base, { op: 'write', mode: 'chat' }, { origin: 'https://evil.example' })
  assert.equal(hostile.status, 403)
  assert.equal(hostile.body.ok, false)
  const after = await post(server.base, { op: 'read' })
  assert.equal(after.body.state.mode, 'harness', 'a rejected origin changed nothing')
  await server.close()
  console.log('ok 4 - only the shell origin can write; a foreign origin is refused untouched')
}

// 5. Bad input and unknown ops answer 4xx instead of crashing the route.
{
  const server = await listen(mount())
  const unknown = await post(server.base, { op: 'nope' })
  assert.equal(unknown.status, 400)
  const badJson = await fetch(server.base, { method: 'POST', body: '{oops' })
  assert.equal(badJson.status, 400)
  const wrongMethod = await fetch(server.base)
  assert.equal(wrongMethod.status, 405)
  await server.close()
  console.log('ok 5 - unknown ops, bad JSON and GET are refused cleanly')
}

// 6. The client diagnostics ledger appends one line per report.
{
  const server = await listen(mount())
  await post(server.base, { op: 'diag', entry: { stage: 'client-probe', note: 'hello' } })
  const lines = (await readFile(join(home, 'dsh-deepseek-switch', 'diag.ndjson'), 'utf8')).trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(last.stage, 'client-probe')
  assert.equal(last.source, 'client')
  assert.equal(last.note, 'hello')
  await server.close()
  console.log('ok 6 - client diagnostics reach diag.ndjson')
}

/* ------------------------------------------------------------------ session */

/* A fake Electron main-process API: one partition, a cookie jar, and a record of every
   `cookies.set` call, so the snapshot logic runs for real without Electron. */
function fakeElectron(initial = []) {
  const jar = new Map(initial.map((cookie) => [cookie.name, { ...cookie }]))
  const writes = []
  return {
    writes,
    jar,
    api: {
      session: {
        fromPartition: (name) => ({
          name,
          cookies: {
            get: async () => [...jar.values()].map((cookie) => ({ ...cookie })),
            set: async (details) => {
              writes.push(details)
              jar.set(details.name, details)
            },
          },
        }),
      },
    },
  }
}

const PARTITION = 'dsh-sidebar-browser-0123456789abcdef'
const snapshotFile = () => join(home, 'dsh-deepseek-switch', 'session.json')
const deepseekCookie = { name: 'ds_session', value: 'SECRET-VALUE', domain: '.deepseek.com', path: '/', secure: true, httpOnly: true }

// 7. A save keeps DeepSeek cookies only, drops the WAF clearance, and filters the page state.
{
  const electron = fakeElectron([
    deepseekCookie,
    { name: 'other', value: 'nope', domain: '.example.com', path: '/', secure: true, httpOnly: false },
    { name: 'aws-waf-token', value: 'challenge', domain: '.deepseek.com', path: '/', secure: true, httpOnly: true },
  ])
  setElectronLoader(async () => electron.api)
  const server = await listen(mount())
  const saved = await post(server.base, {
    op: 'session-save',
    partition: PARTITION,
    storage: [['ds_key', 'v'], ['aws_waf_state', 'z'], ['awswaf_thing', 'z']],
    cookie: 'ds_a=1; aws-waf-token=challenge',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.cookies, 1, 'one DeepSeek cookie is captured')
  assert.equal(saved.body.storage, 1, 'the WAF storage key is not kept')
  const snapshot = JSON.parse(await readFile(snapshotFile(), 'utf8'))
  assert.deepEqual(snapshot.cookies.map((cookie) => cookie.name), ['ds_session'])
  assert.equal(snapshot.cookies[0].httpOnly, true, 'HttpOnly cookies are captured')
  assert.deepEqual(snapshot.storage, [['ds_key', 'v']])
  assert.equal(snapshot.cookie, 'ds_a=1', 'the WAF cookie is stripped from the page string')
  assert.equal(typeof snapshot.savedAt, 'string')
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(snapshotFile())).mode & 0o777, 0o600, 'the snapshot is user-private')
  }
  await server.close()
  console.log('ok 7 - a save snapshots DeepSeek cookies (HttpOnly included) and drops WAF state')
}

// 8. A restart restores those cookies onto the new guest partition before the page loads.
{
  const electron = fakeElectron()
  setElectronLoader(async () => electron.api)
  const server = await listen(mount())
  const restored = await post(server.base, { op: 'session-restore', partition: PARTITION })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.ok, true)
  assert.equal(restored.body.cookies, 1, 'the cookie is set on the partition')
  assert.equal(restored.body.storage.length, 1)
  assert.equal(restored.body.cookie, 'ds_a=1')
  const write = electron.writes[0]
  assert.equal(write.name, 'ds_session')
  assert.equal(write.value, 'SECRET-VALUE')
  assert.equal(write.domain, '.deepseek.com')
  assert.equal(write.url, 'https://deepseek.com/')
  assert.equal(write.httpOnly, true, 'HttpOnly survives the round trip')
  assert.equal(write.secure, true)
  await server.close()
  console.log('ok 8 - a restarted host half puts the login back on the guest partition')
}

// 9. The unload beacon carries no page state and must not erase what the last save kept.
{
  const server = await listen(mount())
  const beacon = await post(server.base, { op: 'session-save', partition: PARTITION })
  assert.equal(beacon.status, 200)
  const snapshot = JSON.parse(await readFile(snapshotFile(), 'utf8'))
  assert.equal(snapshot.storage.length, 1, 'previous storage survives an unload save')
  assert.equal(snapshot.cookie, 'ds_a=1', 'previous page cookie survives an unload save')
  assert.equal(snapshot.cookies.length, 1)
  await server.close()
  console.log('ok 9 - an unload save keeps the previous storage and cookie')
}

// 10. A corrupt snapshot is reported, left on disk, and replaced only by the next good save.
{
  const { writeFile } = await import('node:fs/promises')
  await writeFile(snapshotFile(), '{"cookies": [broken', 'utf8')
  const electron = fakeElectron()
  setElectronLoader(async () => electron.api)
  const server = await listen(mount())
  const restored = await post(server.base, { op: 'session-restore', partition: PARTITION })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.cookies, 0)
  assert.equal(await readFile(snapshotFile(), 'utf8'), '{"cookies": [broken', 'a corrupt snapshot is not deleted')
  const saved = await post(server.base, { op: 'session-save', partition: PARTITION, storage: [['k', 'v']], cookie: 'c=1' })
  assert.equal(saved.status, 200)
  const snapshot = JSON.parse(await readFile(snapshotFile(), 'utf8'))
  assert.deepEqual(snapshot.storage, [['k', 'v']])
  await server.close()
  console.log('ok 10 - a corrupt snapshot is reported, preserved, and replaced only by a good save')
}

// 11. Without an Electron session API the save still keeps page state and says so.
{
  setElectronLoader(async () => {
    throw new Error('no electron here')
  })
  const server = await listen(mount())
  const saved = await post(server.base, { op: 'session-save', partition: PARTITION, storage: [['k2', 'v2']], cookie: 'c2=1' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.match(saved.body.error, /no electron here|session API/)
  const snapshot = JSON.parse(await readFile(snapshotFile(), 'utf8'))
  assert.deepEqual(snapshot.storage, [['k2', 'v2']], 'degraded mode still stores page state')
  const restored = await post(server.base, { op: 'session-restore', partition: PARTITION })
  assert.equal(restored.body.ok, false, 'the missing capability is reported, not hidden')
  assert.equal(restored.body.cookie, 'c2=1')
  await server.close()
  console.log('ok 11 - a missing Electron session API degrades to page state and reports it')
}

// 12. Neither a foreign partition name nor the diagnostics ledger leaks a credential.
{
  const electron = fakeElectron()
  setElectronLoader(async () => electron.api)
  const server = await listen(mount())
  const badPartition = await post(server.base, { op: 'session-restore', partition: 'persist:someone-else' })
  assert.equal(badPartition.status, 400)
  const badSave = await post(server.base, { op: 'session-save', partition: 'default' })
  assert.equal(badSave.status, 400)
  const state = await post(server.base, { op: 'session-state' })
  assert.equal(state.body.session.electron, 'ready')
  const ledger = await readFile(join(home, 'dsh-deepseek-switch', 'diag.ndjson'), 'utf8')
  assert.equal(ledger.includes('SECRET-VALUE'), false, 'no cookie value reaches diag.ndjson')
  assert.equal(ledger.includes('ds_session'), false, 'not even a cookie name reaches it')
  await server.close()
  console.log('ok 12 - only guest partitions are touched and the ledger holds no credential')
}

await rm(home, { recursive: true, force: true })
console.log('\n12/12 host-half checks passed')
