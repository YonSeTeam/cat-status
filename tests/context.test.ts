import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

// What the engine settles the compaction window to; the rest of a breakdown is
// left empty, the meter reads only these two.
type Compaction = { window: number; isOn: boolean }

const breakdownOf = ({ window, isOn }: Compaction): SessionContextBreakdown => ({
  categories: [],
  totalTokens: 0,
  maxTokens: window,
  rawMaxTokens: window,
  autocompactSource: 'settings',
  percentage: 0,
  gridRows: [],
  model: 'test-model',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: isOn,
  apiUsage: null,
})

// A session on a 1M model, out of any room, whose usage answers a breakdown
// only when asked for one, as the engine does.
const startSession = async ($: Engine, on: On, compaction: Compaction) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { lang: 'ru' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('session.measure', async () => ({ changed: [] }))
  on('session.usage', async (_$, e) => ({
    value: {
      startedAt: NOW,
      context: {
        tokens: 433_900,
        window: 1_000_000,
        percent: 43,
        ...(e.breakdown === undefined ? {} : { breakdown: breakdownOf(compaction) }),
      },
      rateLimits: [],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return clock
}

const meterTexts = async ($: Engine) => {
  const ui = await $.ui.mount({
    plugin: 'cat-status',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()
  return texts
}

test('a compaction window under the model\'s: the context fills against it', async ($, on) => {
  await startSession($, on, { window: 500_000, isOn: true })
  const texts = await meterTexts($)
  expect(texts).toContain('87%')
  expect(texts).toContain('434k / 500k')
  expect(texts).not.toContain('43%')
})

test('with auto-compaction off, the context fills against the model\'s window', async ($, on) => {
  await startSession($, on, { window: 500_000, isOn: false })
  const texts = await meterTexts($)
  expect(texts).toContain('43%')
  expect(texts).toContain('434k / 1M')
})

test('a window changed between turns counts from the next turn, and readings fill against it', async ($, on) => {
  const compaction = { window: 500_000, isOn: true }
  const clock = await startSession($, on, compaction)
  compaction.window = 300_000
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  await $.session.measure({ context: { tokens: 250_000, window: 1_000_000, percent: 25 }, rateLimits: [], changed: ['context'] })
  const texts = await meterTexts($)
  expect(texts).toContain('83%')
  expect(texts).toContain('250k / 300k')
})
