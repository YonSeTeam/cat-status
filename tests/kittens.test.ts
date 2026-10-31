import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentStatus, On, ToolCallArgs } from 'claude-code'

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0)

// teammateId: the agent is an in-process teammate.
type Agent = { id: string; status: AgentStatus; teammateId?: string }
// hold: a WebFetch waits on it, as a tool waits behind its permission dialog.
type Options = { room?: boolean; friend?: Record<string, unknown>; hold?: Promise<void> }

// A session whose $.agent.list answers from `agents`, and whose Agent tool
// lists each agent it starts as running, the way the engine does.
const startSession = async ($: Engine, on: On, options: Options = {}) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    lang: 'ru',
    friends: { server: 'http://cats.test', room: options.room === false ? '' : 'cat-test', name: 'кот', color: 'pink', share: false, notify: false, mood: '' },
  })
  const agents: Agent[] = []
  const beats: Record<string, unknown>[] = []
  let started = 0
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'test-session-0001' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', async () => ({}))
  on('classic.SubagentStart', async () => ({}))
  on('agent.list', async () => ({
    value: agents.map(a => ({
      id: a.id,
      description: 'probe',
      type: a.teammateId === undefined ? 'general-purpose' : 'teammate',
      status: a.status,
      ...(a.teammateId === undefined ? {} : { teammateId: a.teammateId }),
    })),
  }))
  on('agent.spawn', async () => {
    started++
    const id = `a${started.toString(16).padStart(16, '0')}`
    agents.push({ id, status: 'running' })
    return { model: 'test-model', agentId: id }
  })
  // A tool reading a file called `missing` fails.
  on('tool.call', async (_$, e) => {
    if (e.tool === 'WebFetch') await options.hold
    return {
      result: { stdout: '', stderr: '', interrupted: false },
      ...('file_path' in e && e.file_path === 'missing' ? { isError: true } : {}),
    }
  })
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/beat') && typeof e.init?.body === 'string') beats.push(JSON.parse(e.init.body))
    const members = [{ id: 'me', self: true, name: 'кот', color: 'pink', status: 'idle' }, ...(options.friend ? [options.friend] : [])]
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ members, events: [] }) } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  // The Agent tool starting a general-purpose agent in the background.
  const spawn = async () => {
    const { agentId } = await $.agent.spawn({
      tool_use_id: `toolu_${started + 1}`,
      prompt: 'Read the README.',
      description: 'probe',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'test-model',
      background: true,
      fork: false,
    })
    if (agentId === undefined) throw new Error('no agent started')
    return agentId
  }
  return { clock, agents, beats, spawn }
}

const band = (surface: 'desktop' | 'terminal' = 'desktop') => ({
  plugin: 'cat-status',
  surface,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} },
})

// The cat's own line, as the band draws it now.
const captionLine = async ($: Engine) => {
  const ui = await $.ui.mount(band())
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()
  return texts[0] ?? ''
}

const factsLine = async ($: Engine) => {
  const ui = await $.ui.mount(band())
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  await ui.unmount()
  return texts[1] ?? ''
}

// The yard as drawn now: an SVG of one-pixel rects.
const yardNow = async ($: Engine) => {
  const ui = await $.ui.mount(band())
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  return String(svg?.props.source ?? '')
}

// White pixels in rows 9 to 12: only a kitten's '?' puts them there (the
// cat's eyes are higher, a kitten's are black).
const isAnyKittenAsking = (yard: string) =>
  [...yard.matchAll(/<rect x="\d+" y="(\d+)" width="\d+" height="1" fill="#ffffff"\/>/g)].some(m => {
    const y = Number(m[1])
    return y >= 9 && y <= 12
  })

// A tear's blue: on a pink cat only a crying cat or kitten shows it.
const TEAR = '#5aa0ff'

const cat = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'cat',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

// A tool call in an agent's loop. The kit types $.tool.call as the main
// loop's, so the loop's id rides beside the call, as the engine sends it.
const agentTool = ($: Engine, agentId: string, input: ToolCallArgs) => {
  const call = { ...input, agentId }
  return $.tool.call(call)
}

const complete = (reason: 'answer' | 'aborted' | 'error', agentId?: string) => ({
  answer: '',
  durationMs: 1000,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
  ...(agentId === undefined ? {} : { agentId }),
})

// A new session's cat sleeps; an agent wakes it with a kitten, and the cat
// stays up a minute after the kitten goes.
test('an agent brings a kitten while it works and takes it away when it ends', async ($, on) => {
  const { clock, agents, spawn } = await startSession($, on)
  expect(await captionLine($)).toBe('спит... zZ')

  const id = await spawn()
  expect(await captionLine($)).toBe('1 котёнок за работой')

  await $.turn.complete(complete('answer', id))
  agents[0]!.status = 'completed'
  expect(await captionLine($)).toBe('мур...')
  expect(await cat($, 'stats')).toContain('котят выросло: 1')

  // The poll still sees the agent, finished: no kitten comes back for it.
  await clock.advance(30_000)
  expect(await captionLine($)).toBe('мур...')
})

test('an agent that fails sends its kitten off with no count', async ($, on) => {
  const { spawn } = await startSession($, on)
  const id = await spawn()
  await $.turn.complete(complete('error', id))
  expect(await captionLine($)).not.toContain('котён')
  expect(await cat($, 'stats')).toContain('котят выросло: 0')
})

test('the cat stays up while its kittens work and dozes off a minute after the last', async ($, on) => {
  const { clock, agents, spawn } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(complete('answer'))
  const id = await spawn()
  await clock.advance(90_000)
  expect(await captionLine($)).toBe('1 котёнок за работой')

  await $.turn.complete(complete('answer', id))
  agents[0]!.status = 'completed'
  await clock.advance(30_000)
  expect(await captionLine($)).toBe('мур...')
  await clock.advance(40_000)
  expect(await captionLine($)).toBe('спит... zZ')
})

// The count in the caption once grew while the cat slept: background agents'
// tools were added to the turn that had already ended.
test("an agent's tools are its kitten's, not the cat's finished turn", async ($, on) => {
  const { clock, spawn } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/main.py' })
  await $.turn.complete(complete('answer'))
  const id = await spawn()
  await agentTool($, id, { tool: 'Read', file_path: '/work/a.py' })
  await agentTool($, id, { tool: 'Read', file_path: '/work/b.py' })
  await agentTool($, id, { tool: 'Read', file_path: 'missing' })
  expect(await factsLine($)).toBe('0 с · 1 действие · 1 котёнок')
  expect(await captionLine($)).toBe('мяу! готово')
  // Its kitten cries a moment, once it is in the yard (it takes 1.5 s to land).
  await clock.advance(2_000)
  expect(await yardNow($)).toContain(TEAR)
  await clock.advance(2_000)
  expect(await yardNow($)).not.toContain(TEAR)
})

test("an agent's dialog makes its kitten ask, and the cat with it", async ($, on) => {
  const { clock, beats, spawn } = await startSession($, on)
  const id = await spawn()
  await clock.advance(2_000)
  expect(isAnyKittenAsking(await yardNow($))).toBe(false)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: id })
  expect(isAnyKittenAsking(await yardNow($))).toBe(true)
  // The cat rests, but the person is wanted all the same.
  expect(await captionLine($)).toBe('жду тебя!')
  await clock.advance(8_000)
  expect(beats.at(-1)).toMatchObject({ status: 'waiting' })

  await agentTool($, id, { tool: 'Read', file_path: '/work/a.py' })
  expect(isAnyKittenAsking(await yardNow($))).toBe(false)
  expect(await captionLine($)).toBe('1 котёнок за работой')
})

// An agent runs a WebFetch and a Read side by side; the WebFetch waits on a
// dialog. The Read ending first must not end the asking.
test("an agent's other tool ending does not end its ask", async ($, on) => {
  let answer = () => {}
  const hold = new Promise<void>(resolve => {
    answer = resolve
  })
  const { clock, spawn } = await startSession($, on, { hold })
  const id = await spawn()
  await clock.advance(2_000)
  const fetching = agentTool($, id, { tool: 'WebFetch', url: 'https://example.com', prompt: 'read it' })
  await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, agent_id: id })
  await agentTool($, id, { tool: 'Read', file_path: '/work/a.py' })
  expect(isAnyKittenAsking(await yardNow($))).toBe(true)
  expect(await captionLine($)).toBe('жду тебя!')
  answer()
  await fetching
  expect(isAnyKittenAsking(await yardNow($))).toBe(false)
})

// The leftmost pixel of the cat's pink: its tail, as the kittens play at the lane's far end.
const catX = (yard: string) =>
  Math.min(...[...yard.matchAll(/<rect x="(\d+)" y="\d+" width="\d+" height="1" fill="#(?:f58ab8|d85f93)"\/>/g)].map(m => Number(m[1])))

test('a resting cat stands still at home while a kitten asks', async ($, on) => {
  const { clock, spawn, beats } = await startSession($, on)
  const id = await spawn()
  await clock.advance(2_000)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: id })
  const xs: number[] = []
  for (let i = 0; i < 12; i++) {
    xs.push(catX(await yardNow($)))
    await clock.advance(2_000)
  }
  expect(new Set(xs).size).toBe(1)
  // A turn starting meanwhile still tells friends the cat waits.
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.settle()
  expect(beats.at(-1)).toMatchObject({ status: 'waiting' })
})

test("an agent's tool does not end the cat's own wait for a dialog", async ($, on) => {
  const { spawn } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const id = await spawn()
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  expect(await captionLine($)).toBe('жду тебя!')
  await agentTool($, id, { tool: 'Read', file_path: '/work/a.py' })
  expect(await captionLine($)).toBe('жду тебя!')
})

// The engine's own helper loops (memory notes after a turn) carry ids shaped
// like an agent's, but no SubagentStart: no kitten. A workflow's agents are
// never listed: theirs comes with SubagentStart and goes with the turn.
test("the engine's own helpers get no kitten; a workflow's agents do", async ($, on) => {
  const { clock } = await startSession($, on)
  await agentTool($, 'a1f2e3d4c5b6a7980', { tool: 'Write', file_path: '/memory/note.md', content: 'x' })
  expect(await captionLine($)).toBe('спит... zZ')

  await $.classic.SubagentStart({ agent_id: 'a0123456789abcdef', agent_type: 'workflow-subagent' })
  expect(await captionLine($)).toBe('1 котёнок за работой')
  await agentTool($, 'a0123456789abcdef', { tool: 'Read', file_path: '/work/a.py' })
  await clock.advance(4_000)
  expect(await captionLine($)).toBe('1 котёнок за работой')
  await $.turn.complete(complete('answer', 'a0123456789abcdef'))
  expect(await captionLine($)).toBe('мур...')
  expect(await cat($, 'stats')).toContain('котят выросло: 1')
})

test('the poll follows $.agent.list, and a winding-down agent does not come back', async ($, on) => {
  const { clock, agents } = await startSession($, on)
  // An agent held on its own background work is no reason for a kitten.
  agents.push(
    { id: 'a00000000000000aa', status: 'running' },
    { id: 'a00000000000000bb', status: 'pending' },
    { id: 'a00000000000000cc', status: 'waiting' },
  )
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('2 котёнка за работой')
  await clock.advance(2_000)
  expect(isAnyKittenAsking(await yardNow($))).toBe(false)

  agents[0]!.status = 'killed'
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('1 котёнок за работой')

  // Its turn has ended while the list still shows it at work.
  await $.turn.complete(complete('answer', 'a00000000000000bb'))
  agents[1]!.status = 'running'
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('мур...')
  expect(await cat($, 'stats')).toContain('котят выросло: 1')
})

// An agent that ends its run while a background command of its own goes on is
// listed as 'waiting' until that ends. Its kitten has gone, and stays gone.
test('an agent done but for its background work does not come back, nor count twice', async ($, on) => {
  const { clock, agents, spawn } = await startSession($, on)
  const id = await spawn()
  await $.turn.complete(complete('answer', id))
  agents[0]!.status = 'waiting'
  await clock.advance(70_000)
  expect(await captionLine($)).toBe('спит... zZ')
  agents[0]!.status = 'completed'
  await clock.advance(70_000)
  expect(await captionLine($)).toBe('спит... zZ')
  expect(await cat($, 'stats')).toContain('котят выросло: 1')
})

test('agents finishing together with the turn all count', async ($, on) => {
  const { clock, spawn } = await startSession($, on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ids = [await spawn(), await spawn(), await spawn()]
  await Promise.all([...ids.map(id => $.turn.complete(complete('answer', id))), $.turn.complete(complete('answer'))])
  const stats = await cat($, 'stats')
  expect(stats).toContain('котят выросло: 3')
  expect(stats).toContain('1 задача закрыто')
  // The turns' beats crossed and run on: let them land.
  await clock.settle()
})

test('a teammate gets its kitten back for its next turn', async ($, on) => {
  const { clock, agents } = await startSession($, on)
  agents.push({ id: 'ascout-0123456789abcdef', status: 'running', teammateId: 'scout@team' })
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('1 котёнок за работой')
  await $.turn.complete(complete('answer', 'ascout-0123456789abcdef'))
  agents[0]!.status = 'idle'
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('мур...')
  agents[0]!.status = 'running'
  await clock.advance(2_000)
  expect(await captionLine($)).toBe('1 котёнок за работой')
})

test('friends hear how many kittens there are', async ($, on) => {
  const { clock, beats, spawn } = await startSession($, on)
  await spawn()
  await spawn()
  await clock.advance(8_000)
  expect(beats.at(-1)).toMatchObject({ kits: 2 })
})

test("a friend's kittens keep its cat up, and their count ends the lines about it", async ($, on) => {
  await startSession($, on, {
    friend: { id: 'kent', name: 'Кент', color: 'green', status: 'busy', doing: 'правит main.py', statusSeconds: 300, today: 5, limit5: 64, kits: 12 },
  })
  const ui = await $.ui.mount(band())
  expect(await ui.find({ type: 'Text', text: 'работает · правит main.py · 12 котят' })).toBeDefined()
  await ui.unmount()
  expect(await cat($, 'who')).toContain('Кент — работает (правит main.py) · сегодня 5 задач · 5 ч 64% · 12 котят')
})

test('kittens coming and going move nothing on the band', async ($, on) => {
  const { clock, spawn } = await startSession($, on, {
    friend: { id: 'kent', name: 'Кент', color: 'green', status: 'idle', statusSeconds: 300, kits: 0 },
  })
  const widths = async () => {
    const ui = await $.ui.mount({ ...band(), props: { ...band().props, bodyColumns: 75 } })
    const svg = await ui.find({ type: 'Svg' })
    await ui.unmount()
    return svg?.props.width
  }
  const before = await widths()
  for (let i = 0; i < 5; i++) await spawn()
  await clock.advance(2_000)
  expect(await widths()).toBe(before)
})

test('nobody wears a crown, not even the day leader', async ($, on) => {
  await startSession($, on, {
    friend: { id: 'kent', name: 'Кент', color: 'green', status: 'idle', statusSeconds: 5, today: 5 },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /👑/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Кент/ })).toBeDefined()
    await ui.unmount()
  }
})
