import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

const ROOM = { members: [{ id: 'me', self: true, name: 'кот', color: 'pink', status: 'idle' }], events: [] }

// A session with `friends` saved in the store; every request and toast is kept.
const startSession = async ($: Engine, on: On, friends: Record<string, unknown>, reply: unknown = ROOM) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { lang: 'ru', friends: { name: 'кот', color: 'pink', share: false, notify: false, mood: '', ...friends } })
  const urls: string[] = []
  const toasts: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('agent.list', async () => ({ value: [] }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('http.fetch', async (_$, e) => {
    urls.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, urls, toasts }
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

test('with no server set, a saved room sends nothing and says how to get back', async ($, on) => {
  const { clock, urls, toasts } = await startSession($, on, { room: 'cat-test' })
  await clock.advance(30_000)
  expect(urls).toEqual([])
  expect(toasts.some(t => t.includes('/cat server'))).toBe(true)
  expect(await cat($, 'invite')).toContain('/cat server')
  expect(await cat($, 'friend new')).toContain('/cat server')
  expect(urls).toEqual([])
})

test('/cat server takes only an http(s) address', async ($, on) => {
  const { urls } = await startSession($, on, { room: 'cat-test' })
  expect(await cat($, 'server cats.example.com')).toContain('http://host:9797')
  expect(await cat($, 'server ftp://cats.example.com')).toContain('http://host:9797')
  expect(await cat($, 'server http://me:secret@cats.example.com')).toContain('http://host:9797')
  expect(await cat($, 'server http://:')).toContain('http://host:9797')
  expect(await cat($, 'server')).toContain('не задан')
  expect(urls).toEqual([])
})

test('/cat server joins the saved room there, and beats and invites use it', async ($, on) => {
  const { clock, urls } = await startSession($, on, { room: 'cat-test' })
  expect(await cat($, 'server https://cats.example.com/')).toContain('«cat-test»')
  await clock.advance(8_000)
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.every(u => u === 'https://cats.example.com/beat')).toBe(true)
  const invite = await cat($, 'invite')
  expect(invite).toContain('https://cats.example.com/install')
  expect(invite).toContain('/cat server https://cats.example.com')
})

test('a server sending the wrong types draws friends with defaults instead of breaking the band', async ($, on) => {
  const junk = {
    members: [
      { id: 'me', self: true, name: 'кот', color: 'pink', status: 'idle' },
      { id: 'odd', name: 42, color: ['x'], status: 'evil', mood: { a: 1 }, today: 'many', limit5: 'full', bubble: 'hi', kits: 'lots', doing: 'правит main.py' },
      'not a member',
    ],
    events: [{ kind: 'hack', from: 'x' }, { kind: 'say', from: 7, text: 'привет' }, null],
  }
  const { clock } = await startSession($, on, { server: 'https://cats.example.com', room: 'cat-test' }, junk)
  await clock.advance(8_000)
  const ui = await $.ui.mount({
    plugin: 'cat-status',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()
  expect(texts).toContain('кот')
  expect(texts.some(t => t.startsWith('отдыхает · правит main.py'))).toBe(true)
  expect(texts.join(' ')).not.toContain('evil')
})
