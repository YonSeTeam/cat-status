import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

const ROOM = {
  members: [
    { id: 'me', self: true, name: 'кот', color: 'pink', status: 'idle', statusSeconds: 5, today: 1 },
    { id: 'kent', self: false, name: 'Кент', color: 'green', status: 'idle', statusSeconds: 5, today: 0, limit5: 20 },
  ],
  events: [],
}

// What the engine answers beneath the plugin in a real session.
const engineBeneath = (on: On) => {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
}

// A session in a room with one friend, the meters filled as on a subscription.
const joinRoom = async ($: Engine, on: On) => {
  engineBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { lang: 'ru', friends: { server: 'http://cats.test', room: 'cat-test', name: 'кот', color: 'pink', share: false, notify: false, mood: '' } })
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 32_000, window: 200_000, percent: 16 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 13 },
        { kind: 'seven_day', percentUsed: 2 },
      ],
      cost: { usd: 2.3 },
    },
  }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(ROOM) } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
}

const band = (bodyColumns: number) => ({
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
})

const GREEN_FUR = '#8ecb6a'

// Desktop, one friend (a 5-hour limit of 20% that is drawn at every width):
// the caption takes 1 + 26 cells and the meters 2 + 9 + 8
// (+ 9 for the bars), the yard on the left the rest, from 12 cells (one cat) up
// to 24 (two). The bars come once the yard can keep its 24 beside them, from 79
// cells; the notes (18 more) after that, from 97. Below 12 + 46 the band is one line.
for (const [width, yardCells, hasBars, hasNotes] of [
  [62, 16, false, false],
  [70, 24, false, false],
  [78, 24, false, false],
  [79, 24, true, false],
  [96, 24, true, false],
  [97, 24, true, true],
  [140, 24, true, true],
] as const) {
  test(`desktop at ${width} columns: one row, a ${yardCells}-cell yard with both cats, meters on the right`, async ($, on) => {
    await joinRoom($, on)
    const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...band(width) })
    expect(await ui.drawn()).toMatchObject({ props: { flexDirection: 'row' } })
    const pictures = await ui.findAll({ type: 'Svg' })
    // The yard, the friend's 5-hour bar (always), and the meters' four bars.
    expect(pictures).toHaveLength(hasBars ? 6 : 2)
    expect(pictures[0]?.props).toMatchObject({ width: yardCells * 8 })
    expect(pictures[1]?.props).toMatchObject({ alt: '5 ч: 20%' })
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
    expect(String(pictures[0]?.props.source)).toContain(GREEN_FUR)
    expect(await ui.find({ key: 'pet-kent' })).toBeDefined()
    expect(await ui.find({ key: 'meow-kent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'неделя' })).toBeDefined()
    expect((await ui.find({ key: 'meters' }))?.props).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end' })
    expect(await ui.find({ type: 'Text', text: '32k / 200k' })).toEqual(hasNotes ? expect.anything() : undefined)
    await ui.unmount()
  })
}

test('desktop below one cat\'s room falls back to the one-line band', async ($, on) => {
  await joinRoom($, on)
  const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...band(57) })
  expect(await ui.find({ key: 'pet-kent' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /👥 Кент/ })).toBeDefined()
  await ui.unmount()
})

// Terminal, one friend: the caption takes 1 + 26 cells and the meters 2 + 9 + 8
// (+ 10 for the bars); the yard is one cell a pixel, from 48 (one cat) up to
// 84, and the bars come once it keeps its 84 beside them, from 140 cells.
for (const [width, yardCells] of [
  [110, 64],
  [130, 84],
  [140, 84],
] as const) {
  test(`terminal at ${width} columns: a ${yardCells}-cell yard and the friend under the caption`, async ($, on) => {
    await joinRoom($, on)
    const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'terminal', ...band(width) })
    expect(await ui.drawn()).toMatchObject({ props: { flexDirection: 'row' } })
    expect((await ui.find({ key: 'cat' }))?.props).toMatchObject({ columns: yardCells })
    expect(await ui.find({ type: 'Text', text: /Кент/ })).toBeDefined()
    // The friend's 5-hour limit, a five-cell text bar and the number.
    expect(await ui.find({ type: 'Text', text: /█░░░░ 20%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'неделя' })).toBeDefined()
    await ui.unmount()
  })
}

test('desktop with no room draws no friends and no room note', async ($, on) => {
  engineBeneath(on)
  mock.clock(on, { now: NOW })
  mock.store(on, { lang: 'ru' })
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'cat-status', surface: 'desktop', ...band(80) })
  expect(await ui.find({ type: 'Text', text: /👥/ })).toBeUndefined()
  expect((await ui.find({ type: 'Svg' }))?.props).toMatchObject({ width: 96 })
  await ui.unmount()
})
