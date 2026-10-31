'use strict'
// cat-sync: tiny presence server for the cat-status mod.
// Rooms are shared secrets. Each person (member id) may run several Claude Code
// sessions; each session posts a heartbeat and the room shows one cat per
// person with the most active status among their live sessions.
// Cats can poke each other (pet, meow, react, say): a poke waits on the server
// until the poked cat's next beat. A note ("say") also shows as a bubble over
// the cat for everyone in the room for a minute.
// /install and /cat-status.zip hand the mod to a friend (files in ./public).
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PORT || 9797)
const PUBLIC = path.join(__dirname, 'public')
const ONLINE_MS = 25_000       // a session not seen within this is offline
const PRUNE_MS = 10 * 60_000   // forget a session entirely after this
const DONE_SHOW_MS = 12_000    // "done" stays visible this long, so pollers catch it
const BUBBLE_MS = 60_000       // a note shows over the cat this long
const MAX_ROOMS = 5000
const MAX_MEMBERS = 50
const MAX_SESSIONS = 20
const MAX_EVENTS = 20
const MAX_KITS = 20            // agents at work a session may report (its cat's kittens)
const RANK = { waiting: 4, busy: 3, done: 2, idle: 1 }
const KINDS = { pet: 2_000, meow: 3_000, react: 1_000, say: 5_000 } // kind -> min gap per pair
const REACTIONS = new Set(['👍', '🔥', '😹'])

// rooms: Map<code, Map<memberId, Member>>
// Member: { name, color, mood, today, lastDone, bubble, events, pokeAt,
//           sessions: Map<sid, { at, status, since, doing, kits, limit5, resetsAt }> }
// The 5-hour limit is kept per session: a session that has no reading yet (just
// opened, no answer so far) sends none, and must not wipe what another showed.
const rooms = new Map()

const now = () => Date.now()
const clip = (v, n) => (typeof v === 'string' ? [...v].slice(0, n).join('') : '')
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)

function roomOf(code) {
  let r = rooms.get(code)
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null
    r = new Map()
    rooms.set(code, r)
  }
  return r
}

function sketch(room, selfId, t) {
  const out = []
  for (const [id, m] of room) {
    let best = null
    let live = 0
    let latest = Infinity
    let kits = 0
    let limit = null
    for (const s of m.sessions.values()) {
      const age = t - s.at
      if (age > ONLINE_MS) continue
      live++
      kits += s.kits
      latest = Math.min(latest, age)
      // The reading to show: the window that resets last (the newest), then the
      // highest use in it. A window already over reads 0, as the next one is empty.
      if (s.limit5 !== null) {
        const isOver = s.resetsAt > 0 && s.resetsAt <= t
        const reading = { resetsAt: isOver ? 0 : s.resetsAt, percent: isOver ? 0 : s.limit5 }
        if (!limit || reading.resetsAt > limit.resetsAt || (reading.resetsAt === limit.resetsAt && reading.percent > limit.percent)) limit = reading
      }
      if (!best || RANK[s.status] > RANK[best.status] || (RANK[s.status] === RANK[best.status] && s.at > best.at)) best = s
    }
    if (!best) continue
    const isFreshDone = best.status === 'idle' && t - m.lastDone < DONE_SHOW_MS
    const bubble = m.bubble && t - m.bubble.at < BUBBLE_MS
      ? { from: m.bubble.from, text: m.bubble.text, secondsLeft: Math.round((BUBBLE_MS - (t - m.bubble.at)) / 1000) }
      : null
    out.push({
      id,
      self: id === selfId,
      name: m.name,
      color: m.color,
      mood: m.mood,
      today: m.today,
      limit5: limit ? limit.percent : null,
      bubble,
      status: isFreshDone ? 'done' : best.status,
      statusSeconds: Math.round((t - (isFreshDone ? m.lastDone : best.since)) / 1000),
      doing: best.doing,
      sessions: live,
      secondsAgo: Math.round(latest / 1000),
      kits: Math.min(MAX_KITS, kits),
    })
  }
  out.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.name.localeCompare(b.name)))
  return out
}

function prune(t) {
  for (const [code, room] of rooms) {
    for (const [id, m] of room) {
      for (const [sid, s] of m.sessions) if (t - s.at > PRUNE_MS) m.sessions.delete(sid)
      if (m.sessions.size === 0) room.delete(id)
    }
    if (room.size === 0) rooms.delete(code)
  }
}
setInterval(() => prune(now()), 60_000).unref()

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req, res, fn) {
  let data = ''
  let tooBig = false
  req.on('data', c => {
    data += c
    if (data.length > 4096) { tooBig = true; req.destroy() }
  })
  req.on('end', () => {
    if (tooBig) return
    let b
    try { b = JSON.parse(data) } catch { return send(res, 400, { error: 'bad json' }) }
    // `null`, a number or a list parse fine but are no request: reading fields off them would crash the process.
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'bad json' })
    fn(b)
  })
}

// The guide names this server by its own address, so no address ships with
// the code: PUBLIC_URL when it sits behind a proxy, else the host the friend reached.
function serveInstall(req, res) {
  fs.readFile(path.join(PUBLIC, 'install.md'), 'utf8', (err, text) => {
    if (err) return send(res, 404, { error: 'not found' })
    const base = (process.env.PUBLIC_URL || `http://${req.headers.host || `localhost:${PORT}`}`).replace(/\/+$/, '')
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(text.replaceAll('{{SERVER}}', base))
  })
}

function serveFile(res, name, type) {
  fs.readFile(path.join(PUBLIC, name), (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' })
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
    res.end(buf)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/health') return send(res, 200, { ok: true, rooms: rooms.size })
  if (url.pathname === '/install') return serveInstall(req, res)
  if (url.pathname === '/cat-status.zip') return serveFile(res, 'cat-status.zip', 'application/zip')

  if (url.pathname === '/beat' && req.method === 'POST') {
    return readBody(req, res, b => {
      const code = clip(b.room, 64)
      const id = clip(b.id, 64)
      const sid = clip(b.session, 64) || 'main'
      if (!code || !id) return send(res, 400, { error: 'room and id required' })
      const room = roomOf(code)
      if (!room) return send(res, 503, { error: 'too many rooms' })
      const t = now()
      let m = room.get(id)
      if (!m) {
        if (room.size >= MAX_MEMBERS) return send(res, 503, { error: 'room full' })
        m = { name: '', color: '', mood: '', today: 0, lastDone: 0, bubble: null, events: [], pokeAt: new Map(), sessions: new Map() }
        room.set(id, m)
      }
      if (!m.sessions.has(sid) && m.sessions.size >= MAX_SESSIONS) return send(res, 503, { error: 'too many sessions' })
      m.name = clip(b.name, 24) || 'кот'
      m.color = clip(b.color, 16) || 'orange'
      m.mood = clip(b.mood, 4)
      m.today = num(b.today, 0, 100000) ?? 0
      const status = RANK[b.status] ? b.status : 'idle'
      const old = m.sessions.get(sid)
      const kits = Math.floor(num(b.kits, 0, MAX_KITS) ?? 0) // optional; older mods send none
      if (status === 'done') m.lastDone = t
      m.sessions.set(sid, {
        at: t,
        status,
        // The last kitten leaving starts the rest anew: the cat dozes off a minute after it.
        since: old && old.status === status && !(old.kits > 0 && kits === 0) ? old.since : t,
        doing: clip(b.doing, 40), // optional; the mod sends '' unless the person shares it
        kits,
        // Optional: mods before this one send the percent alone, and no reset time.
        limit5: num(b.limit5, 0, 1000),
        resetsAt: typeof b.limit5ResetsAt === 'string' ? Date.parse(b.limit5ResetsAt) || 0 : 0,
      })
      // Pokes wait here for the poked cat and are handed over once.
      const events = m.events.map(e => ({ kind: e.kind, from: e.from, text: e.text, secondsAgo: Math.round((t - e.at) / 1000) }))
      m.events = []
      return send(res, 200, { ok: true, members: sketch(room, id, t), events })
    })
  }

  if (url.pathname === '/poke' && req.method === 'POST') {
    return readBody(req, res, b => {
      const room = rooms.get(clip(b.room, 64))
      const fromId = clip(b.id, 64)
      const toId = clip(b.to, 64)
      const from = room && room.get(fromId)
      const to = room && room.get(toId)
      const kind = typeof b.kind === 'string' && KINDS[b.kind] ? b.kind : null
      if (!from || !to || fromId === toId) return send(res, 404, { error: 'no such cat' })
      if (!kind) return send(res, 400, { error: 'bad kind' })
      let text = ''
      if (kind === 'react') {
        text = clip(b.text, 4)
        if (!REACTIONS.has(text)) return send(res, 400, { error: 'bad reaction' })
      } else if (kind === 'say') {
        text = clip(b.text, 60).trim()
        if (!text) return send(res, 400, { error: 'empty note' })
      }
      const t = now()
      const key = `${toId}:${kind}`
      if (t - (from.pokeAt.get(key) || 0) < KINDS[kind]) return send(res, 429, { error: 'not so fast' })
      from.pokeAt.set(key, t)
      to.events.push({ kind, from: from.name, text, at: t })
      if (to.events.length > MAX_EVENTS) to.events.shift()
      if (kind === 'say') to.bubble = { from: from.name, text, at: t }
      return send(res, 200, { ok: true })
    })
  }

  if (url.pathname === '/leave' && req.method === 'POST') {
    return readBody(req, res, b => {
      const room = rooms.get(clip(b.room, 64))
      const m = room && room.get(clip(b.id, 64))
      if (m) {
        m.sessions.delete(clip(b.session, 64) || 'main')
        if (m.sessions.size === 0) room.delete(clip(b.id, 64))
      }
      return send(res, 200, { ok: true })
    })
  }

  if (url.pathname === '/room' && req.method === 'GET') {
    const room = rooms.get(clip(url.searchParams.get('room'), 64))
    if (!room) return send(res, 200, { members: [] })
    return send(res, 200, { members: sketch(room, clip(url.searchParams.get('id'), 64), now()) })
  }

  send(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => console.log('cat-sync on :' + PORT))
