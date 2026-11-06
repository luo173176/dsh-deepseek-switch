import assert from 'node:assert/strict'

/**
 * Geometry rule of the Chat overlay: it must occupy exactly the app frame's centre column —
 * never the left sidebar, the right panel, or the native titlebar band. These checks run the
 * shipped `frameOffsets` (exposed as `__geometry`) against fake layout boxes, so a regression
 * in the rule fails without starting the desktop app.
 */

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}

await import('../client.js')

const React = {
  createElement() {},
  useState() {},
  useEffect() {},
  useRef() {},
  Fragment: Symbol('Fragment'),
}
const plugin = definition.factory(() => React)
const offsets = plugin.__geometry
assert.equal(typeof offsets, 'function', 'client.js must expose __geometry')

const box = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})

function frame({ sidebar = 280, rightbar = 0, viewport = 1280, paddingTop = 40 } = {}) {
  const frameBox = box(0, 0, viewport, 800)
  const centre = box(sidebar, paddingTop, viewport - sidebar - rightbar, 800 - paddingTop)
  return {
    getBoundingClientRect: () => frameBox,
    children: [
      { className: 'mP3x-q_sidebarCol', getBoundingClientRect: () => box(0, 0, sidebar, 800) },
      { className: 'mP3x-q_centerCol', getBoundingClientRect: () => centre },
      { className: 'mP3x-q_rightbarCol', getBoundingClientRect: () => box(viewport - rightbar, 0, rightbar, 800) },
    ],
  }
}

/* 1. Right panel closed: the surface fills everything right of the sidebar, below the titlebar. */
assert.deepEqual(offsets(frame()), { left: 280, right: 0, top: 40, source: 'centre', raw: '' })

/* 2. Right panel open as a 598px track: the surface stops at its edge instead of covering it. */
assert.deepEqual(offsets(frame({ rightbar: 598 })), { left: 280, right: 598, top: 40, source: 'centre', raw: '' })

/* 3. Left sidebar collapsed: no left offset. */
assert.deepEqual(offsets(frame({ sidebar: 0 })), { left: 0, right: 0, top: 40, source: 'centre', raw: '' })

/* 4. Layout without the shipped centre column: track maths is the documented fallback. */
const oldGetComputedStyle = globalThis.getComputedStyle
globalThis.getComputedStyle = () => ({ gridTemplateColumns: '280px 402px 598px', paddingTop: '40px' })
const noCentre = frame()
noCentre.children = noCentre.children.filter((child) => !child.className.includes('centerCol'))
assert.deepEqual(offsets(noCentre), { left: 280, right: 598, top: 40, source: 'tracks', raw: '280px 402px 598px' })
globalThis.getComputedStyle = oldGetComputedStyle

/* 5. A viewport narrower than the sidebar never produces a negative CSS offset. */
const tight = offsets(frame({ viewport: 200, sidebar: 280 }))
for (const value of [tight.left, tight.right, tight.top]) assert.ok(value >= 0, 'offsets must be non-negative')

console.log('5/5 geometry checks passed')
