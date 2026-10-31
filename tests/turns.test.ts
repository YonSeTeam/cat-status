import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)
const GREEN_FUR = '#8ecb6a'

// toolMs: how long each tool call takes on the mocked clock.
type Options = {
  share?: boolean
  friendBusyFrom?: number
  toolMs?: number
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
}

// A session in a room with one green friend, busy since `friendBusyFrom` or idle.
const startSession = async ($: Engine, on: On, options: Options = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    lang: 'ru',
    friends: { server: 'http://cats.test', room: 'cat-test', name: 'кот', color: 'pink', share: options.share === true, notify: false, mood: '' },
  })
  const beats: Record<string, unknown>[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: options.rateLimits ?? [] } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => {
    if (options.toolMs !== undefined) await clock.sleep(options.toolMs)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/beat') && typeof e.init?.body === 'string') beats.push(JSON.parse(e.init.body))
    const from = options.friendBusyFrom
    const friend = {
      id: 'kent',
      name: 'Кент',
      color: 'green',
      status: from === undefined ? 'idle' : 'busy',
      statusSeconds: from === undefined ? 5 : Math.floor((clock.now() - from) / 1000),
    }
    const room = { members: [{ id: 'me', self: true, name: 'кот', color: 'pink', status: 'idle' }, friend], events: [] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(room) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, beats }
}

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

// `/cat <args>` as typed in the composer.
const cat = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'cat',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

const complete = (reason: 'answer' | 'aborted' | 'error', agentId?: string) => ({
  answer: '',
  durationMs: 1000,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

test('a subagent finishing mid-turn leaves the cat at work and closes no task', async ($, on) => {
  await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('answer', 'agent-1'))
  const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'думает...' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /мяу! готово/ })).toBeUndefined()
  expect(await cat($, 'stats')).toContain('0 задач закрыто')

  await $.turn.complete(complete('answer'))
  expect(await ui.find({ type: 'Text', text: /мяу! готово/ })).toBeDefined()
  expect(await cat($, 'stats')).toContain('1 задача закрыто')
  await ui.unmount()
})

test('an interrupted turn closes no task and tells friends the cat rests', async ($, on) => {
  const { beats } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('aborted'))
  const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /мяу! готово/ })).toBeUndefined()
  expect(await cat($, 'stats')).toContain('0 задач закрыто')
  expect(beats.at(-1)).toMatchObject({ status: 'idle', today: 0 })
  await ui.unmount()
})

// The cat celebrates a closed task for 6 s, then settles and tells friends it
// rests. That end comes from the clock, not only from a timer: a reload of the
// mod drops its timers and keeps its state, which once left the cat jumping for
// good (the engine's test kit cannot drop a timer, so this pins the rule itself).
test('a cat celebrates a closed task for 6 s, then settles', async ($, on) => {
  const { clock, beats } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('answer'))
  await clock.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /мяу! готово/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(3_000)
  ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /мяу! готово/ })).toBeUndefined()
  await ui.unmount()
  await clock.advance(8_000)
  expect(beats.at(-1)).toMatchObject({ status: 'idle' })
})

// The server keeps the 5-hour limit per session and shows the window that resets
// last, so each beat carries the percent and when that window resets. A session
// with no reading sends neither (and the server ignores it).
test('a beat carries the 5-hour limit and when it resets', async ($, on) => {
  const { clock, beats } = await startSession($, on, {
    rateLimits: [
      { kind: 'seven_day', percentUsed: 80, resetsAt: '2026-10-12T00:00:00Z' },
      { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-06T15:00:00Z' },
    ],
  })
  await clock.advance(8_000)
  expect(beats.at(-1)).toMatchObject({ limit5: 41, limit5ResetsAt: '2026-10-06T15:00:00Z' })
})

test('a session with no limit reading sends none', async ($, on) => {
  const { clock, beats } = await startSession($, on)
  await clock.advance(8_000)
  expect(beats.at(-1)).toMatchObject({ limit5: null, limit5ResetsAt: null })
})

test('/cat mood keeps a whole badge', async ($, on) => {
  const { clock } = await startSession($, on)
  expect(await cat($, 'mood ;3')).toBe('Над котом теперь ;3')
  expect(await cat($, 'mood 👍🏽')).toBe('Над котом теперь 👍🏽')
  expect(await cat($, 'mood 🇷🇺 привет')).toBe('Над котом теперь 🇷🇺')
  // The server keeps 4 code points; the badge here is cut the same way.
  expect(await cat($, 'mood ^_^;;')).toBe('Над котом теперь ^_^;')
  expect(await cat($, 'mood off')).toBe('Значок над котом убран.')
  // Each change sends a beat it does not wait for: let them land.
  await clock.settle()
})

test('/cat share sends the program but never its arguments or variables', async ($, on) => {
  const { clock, beats } = await startSession($, on, { share: true, toolMs: 10_000 })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', command: 'API_KEY=sk-secret npm run deploy -- --token abc' })
  await clock.settle()
  await clock.advance(8_000)
  expect(beats.map(b => b.doing)).toContain('запускает npm')
  expect(JSON.stringify(beats)).not.toContain('sk-secret')
  expect(JSON.stringify(beats)).not.toContain('deploy')
  await clock.advance(2_000)
  await call
})

test('/cat share stops sending the last action once the turn is over', async ($, on) => {
  const { clock, beats } = await startSession($, on, { share: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/main.py' })
  await $.turn.complete(complete('answer'))
  await clock.advance(16_000)
  expect(beats.at(-1)).toMatchObject({ status: 'idle', doing: '' })
})

const PINK_FUR = '#f58ab8'

// The yard as drawn now: an SVG of one-pixel rects.
const myYard = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...BAND })
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  return String(svg?.props.source ?? '')
}

// The leftmost pixel of a fur color in the yard, or undefined when it is not there.
const furX = (yard: string, fur: string) => {
  const xs = [...yard.matchAll(new RegExp(`<rect x="(\\d+)" y="\\d+" width="\\d+" height="1" fill="${fur}"/>`, 'g'))].map(m =>
    Number(m[1]),
  )
  return xs.length === 0 ? undefined : Math.min(...xs)
}

// How far the friend's cat is behind this one: 28 pixels exactly while it chases.
const gap = (yard: string) => {
  const mine = furX(yard, PINK_FUR)
  const theirs = furX(yard, GREEN_FUR)
  return mine === undefined || theirs === undefined ? undefined : mine - theirs
}

// The chaser runs 28 pixels behind, so for the first frames of a chase both
// cats are still off the left edge; the friend's cat is not drawn on its own
// meanwhile. It comes into view a few seconds in.
test('a chase starts from the edge when both get busy, not halfway across', async ($, on) => {
  const { clock } = await startSession($, on, { friendBusyFrom: NOW - 20_000 })
  await clock.advance(2_500)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(500)
  expect(furX(await myYard($), GREEN_FUR)).toBeUndefined()
  await clock.advance(3_250)
  expect(gap(await myYard($))).toBe(28)
  await clock.advance(6_250)
  const after = await myYard($)
  expect(furX(after, GREEN_FUR)).toBeDefined()
  expect(gap(after)).not.toBe(28)
})

test('no chase while the friend rests: its cat strolls in the yard on its own', async ($, on) => {
  const { clock } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(3_750)
  const yard = await myYard($)
  expect(furX(yard, GREEN_FUR)).toBeDefined()
  expect(gap(yard)).not.toBe(28)
})
