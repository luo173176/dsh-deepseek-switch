import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Runs the shipped `frameOffsets` inside a real layout engine (Edge headless, over CDP) against
 * the same three-track frame the Harness ships: sidebar | centre (1fr) | right panel, animated
 * 0 → 598px. The Node test proves the arithmetic; this proves it against a browser's own layout,
 * including the mid-transition sample that used to be cached forever.
 */

let definition
globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
await import('../client.js')
const plugin = definition.factory(() => ({ createElement() {}, useState() {}, useEffect() {}, useRef() {}, Fragment: Symbol('x') }))
const source = plugin.__geometry.toString()

const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0}
  .frame{display:grid;width:1280px;height:800px;grid-template-columns:280px minmax(0px,1fr) minmax(0px,0px)}
  .frame.animate{transition:grid-template-columns 400ms linear}
  .col{height:100%}
</style>
<div class="frame" id="frame">
  <div class="mP3x-q_sidebarCol col"></div>
  <div class="mP3x-q_centerCol col" id="centre"></div>
  <div class="mP3x-q_rightbarCol col"></div>
</div>
<script>
const frame = document.getElementById('frame')
const frameOffsets = ${source}
const setCols = (sidebar, right) => { frame.style.gridTemplateColumns = sidebar + 'px minmax(0px,1fr) minmax(0px,' + right + 'px)' }
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
window.__run = async () => {
  const out = {}
  setCols(280, 0); await nextFrame()
  out.closed = frameOffsets(frame)
  setCols(280, 598); await nextFrame()
  out.open = frameOffsets(frame)
  setCols(0, 0); await nextFrame()
  out.collapsed = frameOffsets(frame)
  setCols(280, 0); await nextFrame()
  frame.classList.add('animate')
  setCols(280, 598)
  await nextFrame()
  out.midTransition = frameOffsets(frame)
  await wait(700)
  out.settled = frameOffsets(frame)
  return out
}
</script>`

const dir = mkdtempSync(join(tmpdir(), 'dsx-geom-'))
const file = join(dir, 'fixture.html')
writeFileSync(file, html, 'utf8')
const url = 'file:///' + file.replace(/\\/g, '/')

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })

const endpoint = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('Edge did not report a DevTools endpoint: ' + buffer)), 20000)
  child.stderr.on('data', (chunk) => {
    buffer += String(chunk)
    const hit = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
    if (hit) { clearTimeout(timer); resolve(hit[1]) }
  })
})

const port = new URL(endpoint).port
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP socket failed')) })

let sequence = 0
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence
  const onMessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== id) return
    socket.removeEventListener('message', onMessage)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
  socket.addEventListener('message', onMessage)
  socket.send(JSON.stringify({ id, method, params }))
})

await call('Page.enable', {})
await call('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 600))
const evaluation = await call('Runtime.evaluate', { expression: 'window.__run()', awaitPromise: true, returnByValue: true })
socket.close()
child.kill()
rmSync(dir, { recursive: true, force: true })

const out = evaluation.result.value
assert.ok(out, 'fixture returned no value: ' + JSON.stringify(evaluation).slice(0, 400))
assert.deepEqual(out.closed, { left: 280, right: 0, top: 0, source: 'centre', raw: '' })
assert.deepEqual(out.open, { left: 280, right: 598, top: 0, source: 'centre', raw: '' })
assert.deepEqual(out.collapsed, { left: 0, right: 0, top: 0, source: 'centre', raw: '' })
assert.equal(out.settled.right, 598, 'the settled frame must read the final right panel width')
assert.ok(out.midTransition.right > 0 && out.midTransition.right < 598, 'the mid-transition sample must be intermediate, got ' + out.midTransition.right)

console.log('4/4 browser layout checks passed')
console.log('mid-transition right =', out.midTransition.right, 'px; settled right =', out.settled.right, 'px')
