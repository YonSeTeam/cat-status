import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

// A session with `store` saved; with a room on a server, every beat is kept.
// The test runtime's locale is en-US. toolMs: how long each tool call takes.
const startSession = async ($: Engine, on: On, store: Record<string, unknown>, toolMs = 0) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  const beats: Record<string, unknown>[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => {
    await clock.sleep(toolMs)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/beat') && typeof e.init?.body === 'string') beats.push(JSON.parse(e.init.body))
    const room = { members: [{ id: 'me', self: true, name: 'cat', color: 'pink', status: 'idle' }], events: [] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(room) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, beats }
}

const cat = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'cat',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

const BAND = {
  plugin: 'cat-status',
  surface: 'desktop' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

const ROOM = { server: 'http://cats.test', room: 'cat-test', name: 'cat', color: 'pink', share: true, notify: false, mood: '' }

test('a new cat follows the system language', async ($, on) => {
  await startSession($, on, {})
  expect(await cat($, '')).toContain('Cat commands:')
  expect(await cat($, 'lang')).toContain('The cat speaks English')
})

test('a cat with stats from before keeps speaking Russian', async ($, on) => {
  await startSession($, on, { lifetime: { tasks: 3, tools: 10, errors: 0, longestSeconds: 40, kittens: 0 } })
  expect(await cat($, 'lang')).toContain('Кот говорит по-русски')
  expect(await cat($, 'stats')).toContain('3 задачи закрыто')
})

test('/cat lang switches every word, and anything else leaves it be', async ($, on) => {
  await startSession($, on, { lang: 'en' })
  expect(await cat($, 'lang de')).toContain('The cat speaks English')
  expect(await cat($, 'lang ru')).toContain('Кот говорит по-русски')
  expect(await cat($, 'stats')).toContain('Кот за всё время')
  expect(await cat($, 'lang en')).toContain('The cat speaks English')
  expect(await cat($, 'stats')).toContain('The cat, all time')
  expect(await cat($, 'cache 7')).toContain('The cache lives 5 or 60 minutes')
})

test('the band speaks English: the line, the meters, the pet button', async ($, on) => {
  const { clock } = await startSession($, on, { lang: 'en' }, 10_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call({ tool: 'Read', file_path: 'C:/repo/README.md' })
  await clock.advance(2_000)
  const ui = await $.ui.mount(BAND)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  expect(texts[0]).toBe('reading README.md')
  expect(texts[1]).toBe('2 s · 1 action')
  expect(texts).toContain('cache')
  expect(texts).toContain('warm')
  expect((await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))).toContain('pet')
  await ui.unmount()
  await clock.advance(8_000)
  await call
})

test('/cat share in English sends the program and the search, never their arguments', async ($, on) => {
  const { clock, beats } = await startSession($, on, { lang: 'en', friends: ROOM }, 10_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const run = $.tool.call({ tool: 'Bash', command: 'API_KEY=sk-secret npm run deploy -- --token abc' })
  await clock.settle()
  await clock.advance(8_000)
  expect(beats.map(b => b.doing)).toContain('running npm')
  await clock.advance(2_000)
  await run
  const grep = $.tool.call({ tool: 'Grep', pattern: 'secretPattern' })
  const glob = $.tool.call({ tool: 'Glob', pattern: 'private/**/*.key' })
  await clock.settle()
  await clock.advance(8_000)
  expect(beats.map(b => b.doing)).toContain('searching')
  expect(JSON.stringify(beats)).not.toContain('sk-secret')
  expect(JSON.stringify(beats)).not.toContain('deploy')
  expect(JSON.stringify(beats)).not.toContain('secretPattern')
  expect(JSON.stringify(beats)).not.toContain('private')
  await clock.advance(2_000)
  await grep
  await glob
})

test('a line written in Russian loses its arguments after /cat lang en too', async ($, on) => {
  const { clock, beats } = await startSession($, on, { lang: 'ru', friends: ROOM }, 20_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const run = $.tool.call({ tool: 'Bash', command: 'npm t --token abc123' })
  await clock.advance(2_000)
  await cat($, 'lang en')
  await clock.advance(8_000)
  expect(beats.map(b => b.doing)).toContain('запускает npm')
  expect(JSON.stringify(beats)).not.toContain('abc123')
  await clock.advance(10_000)
  await run
})
