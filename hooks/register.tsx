import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { ContextReading, Friend, FriendStatus, Kitten, Lang, LimitReading, Link, Mood, TurnStats, View } from '../types'

const mood = atom({ plugin: 'cat-status', key: 'mood' } as const, 'idle' as Mood)
const frame = atom({ plugin: 'cat-status', key: 'frame' } as const, 0)
const activity = atom({ plugin: 'cat-status', key: 'activity' } as const, '')
const isSad = atom({ plugin: 'cat-status', key: 'isSad' } as const, false)
const stats = atom({ plugin: 'cat-status', key: 'stats' } as const, {
  startedAt: 0,
  tools: 0,
  errors: 0,
  seconds: 0,
} as TurnStats)
const limits = atom({ plugin: 'cat-status', key: 'limits' } as const, [] as LimitReading[])
const cacheAt = atom({ plugin: 'cat-status', key: 'cacheAt' } as const, 0)
const context = atom({ plugin: 'cat-status', key: 'context' } as const, null as ContextReading | null)
const compactWindow = atom({ plugin: 'cat-status', key: 'compactWindow' } as const, null as number | null)
const costUsd = atom({ plugin: 'cat-status', key: 'costUsd' } as const, null as number | null)
const isWaiting = atom({ plugin: 'cat-status', key: 'isWaiting' } as const, false)
const pettedUntil = atom({ plugin: 'cat-status', key: 'pettedUntil' } as const, 0)
const view = atom({ plugin: 'cat-status', key: 'view' } as const, 'full' as View)
const friends = atom({ plugin: 'cat-status', key: 'friends' } as const, [] as Friend[])
const link = atom({ plugin: 'cat-status', key: 'link' } as const, { room: '', status: 'off' } as Link)
const cacheMinutes = atom({ plugin: 'cat-status', key: 'cacheMinutes' } as const, 60)
// Friend id -> until when their cat shows hearts on this screen.
const pettedFriends = atom({ plugin: 'cat-status', key: 'pettedFriends' } as const, {} as Record<string, number>)
const pokedUntil = atom({ plugin: 'cat-status', key: 'pokedUntil' } as const, 0)
const me = atom({ plugin: 'cat-status', key: 'me' } as const, null as Friend | null)
const kittens = atom({ plugin: 'cat-status', key: 'kittens' } as const, [] as Kitten[])
const kittensDoneAt = atom({ plugin: 'cat-status', key: 'kittensDoneAt' } as const, 0)
const lang = atom({ plugin: 'cat-status', key: 'lang' } as const, 'ru' as Lang)

// ---------- friends: shared presence through a tiny server ----------

const BEAT_MS = 8000
// What is kept across sessions: the friends server's address ('' until
// /cat server sets one: no server ships with the mod), the room code, this
// cat's name and color, whether to share the activity line ('' keeps only the
// status visible), and whether friends coming and going raise a toast.
type FriendsConfig = { server: string; room: string; name: string; color: string; share: boolean; notify: boolean; mood: string }
const FRIENDS_KEY = 'friends'
const ID_KEY = 'machineId'
const SETTINGS_KEY = 'settings'
// Code points a /cat mood badge keeps: as many as the server stores.
const MOOD_MAX = 4

const readConfig = async ($: EngineInterface): Promise<FriendsConfig> => {
  const c = (await $.store.get(FRIENDS_KEY)) as Partial<FriendsConfig> | undefined
  return {
    server: typeof c?.server === 'string' ? c.server : '',
    room: typeof c?.room === 'string' ? c.room : '',
    name: typeof c?.name === 'string' && c.name ? c.name : tr.catName,
    color: typeof c?.color === 'string' && c.color ? c.color : 'orange',
    share: c?.share === true,
    notify: c?.notify !== false,
    mood: typeof c?.mood === 'string' ? c.mood : '',
  }
}

// Tasks closed today, kept in $.store so a restart keeps the count.
const TODAY_KEY = 'today'
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
const todayCount = async ($: EngineInterface) => {
  const saved = (await $.store.get(TODAY_KEY)) as { day?: string; tasks?: number } | undefined
  return saved?.day === dayKey(await $.clock.now()) ? (saved.tasks ?? 0) : 0
}
const bumpToday = async ($: EngineInterface) => {
  const tasks = (await todayCount($)) + 1
  await $.store.set(TODAY_KEY, { day: dayKey(await $.clock.now()), tasks })
  return tasks
}

const saveConfig = async ($: EngineInterface, patch: Partial<FriendsConfig>) => {
  const next = { ...(await readConfig($)), ...patch }
  await $.store.set(FRIENDS_KEY, next)
  return next
}

// The room this cat is in: none until a server is set, whatever code is saved.
const joinedRoom = (cfg: FriendsConfig) => (cfg.server ? cfg.room : '')

// A server address as /cat server takes it: http(s), a host and maybe a port,
// no user or password (/cat invite hands it to friends), no trailing slash.
const serverAddress = (text: string) => {
  const address = text.trim().replace(/\/+$/, '')
  return /^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?(\/[^\s?#]*)?$/i.test(address) ? address : undefined
}

// A code that is easy to read aloud and hard to guess: cat-xxxx-xxxx.
const newRoomCode = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  const part = () => Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
  return `cat-${part()}-${part()}`
}

const machineId = async ($: EngineInterface) => {
  let id = (await $.store.get(ID_KEY)) as string | undefined
  if (typeof id !== 'string' || id.length < 8) {
    id = Math.random().toString(36).slice(2, 12)
    await $.store.set(ID_KEY, id)
  }
  return id
}

const TICK_MS = 250
// The frame counter only ticks the redraw (the band takes its frame from the
// clock); it wraps to stay small.
const FRAME_WRAP = 9600
// How long the prompt cache lives after the last request: 60 min by default,
// `/cat cache 5` for the 5-minute cache. Kept in $.store under SETTINGS_KEY.
const CACHE_WARN_MS = 3 * 60_000
const SLEEP_AFTER_MS = 60_000
// Each activity line stays at least this long, so quick tools do not make the line flicker.
const HOLD_MS = 1500
const PET_MS = 3000
// How long the cat celebrates a closed task before it settles back to idle.
const DONE_MS = 6000
const LIMIT_WARN_PERCENT = 90

// Kept across sessions in $.store.
// `kittens`: agents that finished their work.
type Lifetime = { tasks: number; tools: number; errors: number; longestSeconds: number; kittens: number }
const LIFETIME_KEY = 'lifetime'
const MILESTONES = [10, 50, 100, 250, 500, 1000, 2000, 5000]

const GREEN = '#98c379'
const YELLOW = '#e5c07b'
const RED = '#e06c75'
const GRAY = '#7f848e'

// ---------- words: the cat speaks Russian and English ----------

const pluralRu = (n: number, one: string, few: string, many: string) => {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
}
const pluralEn = (n: number, one: string, many: string) => (n === 1 ? one : many)

const RU = {
  catName: 'кот',
  thinking: 'думает...',
  duration: (s: number) => (s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`),
  actions: (n: number) => `${n} ${pluralRu(n, 'действие', 'действия', 'действий')}`,
  errors: (n: number) => `${n} ${pluralRu(n, 'ошибка', 'ошибки', 'ошибок')}`,
  tasks: (n: number) => `${n} ${pluralRu(n, 'задача', 'задачи', 'задач')}`,
  kittens: (n: number) => `${n} ${pluralRu(n, 'котёнок', 'котёнка', 'котят')}`,
  sessions: (n: number) => `${n} сессии`,
  today: (tasks: string) => `сегодня ${tasks}`,

  // What Claude is doing. Friends get `run` and `search` without what follows
  // them (forFriends), so every phrase that carries arguments starts with one.
  reads: (file: string) => `читает ${file}`,
  edits: (file: string) => `правит ${file}`,
  writes: (file: string) => `пишет ${file}`,
  run: 'запускает',
  runCommand: 'запускает команду',
  search: 'ищет',
  searchText: (text: string) => `ищет «${text}»`,
  searchFiles: (pattern: string) => `ищет файлы ${pattern}`,
  web: 'смотрит в интернете',
  agent: 'зовёт котёнка',
  skill: 'читает инструкцию',
  asks: 'спрашивает тебя',
  uses: (tool: string) => `использует ${tool}`,

  status: { busy: 'работает', waiting: 'ждёт', done: 'готово', idle: 'отдыхает' } as Record<FriendStatus, string>,
  asleep: 'спит',
  purr: 'мррр ♥',
  waitingForYou: 'жду тебя!',
  oops: 'ой, не вышло...',
  done: 'мяу! готово',
  lastTime: (took: string, did: string) => `в прошлый раз: ${took}, ${did}`,
  atWork: (kittens: string) => `${kittens} за работой`,
  sleeping: 'спит... zZ',
  idle: 'мур...',
  poked: 'мяу?! тебя зовут',
  wentHome: 'ушёл домой',
  noLink: 'нет связи с сервером',
  noLinkShort: 'нет связи',
  pile: 'все спят в кучке 💤',
  waitingFriends: 'ждём друзей…',
  pet: 'погладить',
  meow: 'мяу',
  more: (n: number) => `и ещё ${n}`,
  yardAlt: (isCrowd: boolean) => (isCrowd ? 'коты' : 'котик'),

  limits: { five_hour: '5 ч', seven_day: 'неделя', spend_limit: 'бюджет' } as Record<string, string>,
  resetDays: (d: number, h: number) => `↻ ${d} д ${h} ч`,
  resetHours: (h: number, m: number) => `↻ ${h} ч ${m} мин`,
  resetMinutes: (m: number) => `↻ ${m} мин`,
  context: 'контекст',
  cache: 'кеш',
  warm: 'тёплый',
  cold: 'остыл',
  rewrites: 'запишется заново',
  untilCold: 'до остывания',
  cost: 'расход',
  apiPrices: 'по ценам API',
  perSession: 'за сессию',

  lifetime: (life: Lifetime) =>
    [
      `=^.^= Кот за всё время:`,
      `  ${RU.tasks(life.tasks)} закрыто`,
      `  ${RU.actions(life.tools)}`,
      `  ${RU.errors(life.errors)} пережито`,
      `  рекорд: ${RU.duration(life.longestSeconds)} на одну задачу`,
      `  котят выросло: ${life.kittens}`,
    ].join('\n'),
  help: (colors: string) =>
    [
      'Команды кота:',
      '  /cat stats             — статистика за всё время',
      '  /cat compact | full    — одна строка или полная полоска',
      '  /cat hide | show       — спрятать или вернуть кота',
      '  /cat cache 5 | 60      — сколько минут живёт кеш (по умолчанию 60)',
      '  /cat lang ru | en      — язык кота',
      '',
      'Друзья онлайн:',
      '  /cat server <адрес>    — сервер друзей (свой, из папки server/)',
      '  /cat friend new        — создать комнату и получить код для друга',
      '  /cat friend <код>      — войти в комнату по коду',
      '  /cat friend            — какая комната сейчас',
      '  /cat name <имя>        — как тебя видят друзья',
      '  /cat color <цвет>      — ' + colors,
      '  /cat share on | off    — показывать друзьям, что делаешь (по умолчанию off)',
      '  /cat notify on | off   — уведомления «друг в сети / вышел»',
      '  /cat who               — кто в комнате, сколько задач за день, лимиты',
      '  /cat invite            — сообщение для друга: как поставить кота и войти',
      '  /cat preview           — показать, как выглядят друзья (на 30 с)',
      '  /cat solo              — выйти из комнаты',
      '',
      'С друзьями:',
      '  /cat meow [имя|all]    — мяукнуть другу: его кот подпрыгнет с «!»',
      '  /cat say <имя|all> <текст> — записка: висит над его котом минуту',
      '  /cat mood <эмодзи|off> — значок над твоим котом: 🍕 ☕ 🎧 ;3 …',
      '  «погладить» и 👍 🔥 😹 — кнопки под котом друга',
      '',
      'Котята: у кота по котёнку на каждого агента, пока тот работает.',
    ].join('\n'),

  langNow: 'Кот говорит по-русски. /cat lang en переключит на английский.',
  hidden: 'Кот спрятался. /cat show вернёт его.',
  shown: 'Кот на месте =^.^=',
  compacted: 'Кот свернулся в одну строку. /cat full вернёт полоску.',
  cacheChoices: 'Кеш живёт 5 или 60 минут: /cat cache 5 или /cat cache 60',
  cacheSet: (minutes: number) => `Теперь кот считает, что кеш живёт ${minutes} мин.`,
  serverIs: (server: string) => `Сервер друзей: ${server}`,
  serverNone: 'Сервер друзей не задан. Подними свой из папки server/ (см. README) и укажи его: /cat server http://host:9797',
  serverFirst: 'Сначала сервер друзей. Подними свой из папки server/ (см. README) и укажи его: /cat server http://host:9797',
  serverBad: 'Нужен адрес вида http://host:9797 или https://cats.example.com',
  serverSetInRoom: (server: string, room: string) => `Сервер друзей: ${server}. Ты в комнате «${room}».`,
  serverSet: (server: string) => `Сервер друзей: ${server}. Теперь /cat friend new или /cat friend <код>.`,
  inRoom: (room: string, name: string, color: string) => `Ты в комнате «${room}» как ${name} (${color}). Другу: /cat friend ${room}`,
  noRoom: 'Ты не в комнате. /cat friend new создаст комнату, /cat friend <код> войдёт в чужую.',
  joined: (room: string, name: string, color: string) => `Ты в комнате «${room}» как ${name} (${color}).\nОтправь другу: /cat friend ${room}`,
  nameTip: '\nСовет: /cat name <имя>, чтобы друзья видели, кто ты.',
  nameNow: (name: string) => `Сейчас тебя зовут «${name}». Новое имя: /cat name Мурзик`,
  nameSet: (name: string) => `Теперь друзья видят тебя как «${name}».`,
  colorNow: (color: string, colors: string) => `Сейчас ${color}. Цвета: ${colors}`,
  colorSet: (color: string) => `Твой кот у друзей теперь ${color}.`,
  shareOn: 'Друзья видят, что ты делаешь: «правит main.py» и т.п.',
  shareOff: 'Друзья видят только статус, без подробностей.',
  notifyOn: 'Скажу, когда друг зайдёт или выйдет.',
  notifyOff: 'Без уведомлений о друзьях.',
  previewOn: 'Вот так выглядят друзья. Через 30 секунд они исчезнут.',
  notInRoom: 'Ты не в комнате. /cat friend new или /cat friend <код>',
  whoHead: (room: string, tasks: string) => `В комнате «${room}». Ты: сегодня ${tasks}.`,
  noFriendsYet: 'Друзей пока нет: /cat invite',
  tooOften: 'Не так часто: подожди пару секунд.',
  meowSent: (names: string) => `🐾 Мяу → ${names}`,
  sayUsage: 'Так: /cat say Кент глянь PR  (или /cat say all обед?)',
  moodSet: (emoji: string) => `Над котом теперь ${emoji}`,
  moodOff: 'Значок над котом убран.',
  invite: (server: string, room: string) =>
    [
      'Отправь другу:',
      '',
      `  Поставь кота для Claude Code: скажи своему Claude Code «установи кота по инструкции ${server}/install».`,
      `  Потом перезапусти его и напиши /cat server ${server} и /cat friend ${room}`,
    ].join('\n'),
  solo: 'Вышел из комнаты. Снова один кот.',
  roomEmpty: 'В комнате пока никого. /cat invite',
  whom: (names: string) => `Кому? ${names} или all`,
  noSuch: (names: string) => `Нет такого. В комнате: ${names}`,

  limitAlmost: (name: string, percent: number) => `=^o^= Лимит «${name}» почти всё: ${percent}%`,
  online: (name: string) => `=^.^= ${name} в сети`,
  left: (name: string) => `=-.-= ${name} вышел`,
  tooOftenToast: 'Не так часто 🐾',
  pets: (names: string, isMany: boolean) => `♥ ${names} ${isMany ? 'гладят' : 'гладит'} твоего кота`,
  meows: (names: string) => `🐾 ${names}: мяу!`,
  reacts: (emoji: string, from: string) => `${emoji} ${from} — за твою задачу`,
  cacheSoon: '=^-^= Кеш остынет через 3 минуты',
  milestone: (n: number) => `=^ω^= Кот закрыл ${n}-ю задачу!`,
  record: (took: string) => `=^O^= Новый рекорд: ${took} на одну задачу`,
  meowDone: 'Мяу! =^ω^=',
  backToRoom: (room: string) => `=^.^= Чтобы вернуться в комнату «${room}», задай сервер друзей: /cat server <адрес>`,
  commandHelp: 'Кот: статистика, компактный вид, спрятать',
  preview: { kent: 'Кент', vasya: 'Вася', liza: 'Лиза', note: 'глянь PR' },
}
type Words = typeof RU

const EN: Words = {
  catName: 'cat',
  thinking: 'thinking...',
  duration: s => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`),
  actions: n => `${n} ${pluralEn(n, 'action', 'actions')}`,
  errors: n => `${n} ${pluralEn(n, 'error', 'errors')}`,
  tasks: n => `${n} ${pluralEn(n, 'task', 'tasks')}`,
  kittens: n => `${n} ${pluralEn(n, 'kitten', 'kittens')}`,
  sessions: n => `${n} sessions`,
  today: tasks => `today ${tasks}`,

  reads: file => `reading ${file}`,
  edits: file => `editing ${file}`,
  writes: file => `writing ${file}`,
  run: 'running',
  runCommand: 'running a command',
  search: 'searching',
  searchText: text => `searching "${text}"`,
  searchFiles: pattern => `searching files ${pattern}`,
  web: 'browsing the web',
  agent: 'calls a kitten',
  skill: 'reading a skill',
  asks: 'asking you',
  uses: tool => `using ${tool}`,

  status: { busy: 'working', waiting: 'waiting', done: 'done', idle: 'resting' },
  asleep: 'asleep',
  purr: 'purr ♥',
  waitingForYou: 'waiting for you!',
  oops: 'oops, that failed...',
  done: 'meow! done',
  lastTime: (took, did) => `last time: ${took}, ${did}`,
  atWork: kittens => `${kittens} at work`,
  sleeping: 'asleep... zZ',
  idle: 'mrr...',
  poked: "meow?! you're called",
  wentHome: 'went home',
  noLink: 'no connection to the server',
  noLinkShort: 'offline',
  pile: 'all asleep in a pile 💤',
  waitingFriends: 'waiting for friends…',
  pet: 'pet',
  meow: 'meow',
  more: n => `and ${n} more`,
  yardAlt: isCrowd => (isCrowd ? 'cats' : 'a cat'),

  limits: { five_hour: '5 h', seven_day: 'week', spend_limit: 'budget' },
  resetDays: (d, h) => `↻ ${d} d ${h} h`,
  resetHours: (h, m) => `↻ ${h} h ${m} min`,
  resetMinutes: m => `↻ ${m} min`,
  context: 'context',
  cache: 'cache',
  warm: 'warm',
  cold: 'cold',
  rewrites: 'will be rewritten',
  untilCold: 'until cold',
  cost: 'cost',
  apiPrices: 'at API prices',
  perSession: 'this session',

  lifetime: life =>
    [
      `=^.^= The cat, all time:`,
      `  ${EN.tasks(life.tasks)} closed`,
      `  ${EN.actions(life.tools)}`,
      `  ${EN.errors(life.errors)} survived`,
      `  record: ${EN.duration(life.longestSeconds)} on one task`,
      `  kittens raised: ${life.kittens}`,
    ].join('\n'),
  help: colors =>
    [
      'Cat commands:',
      '  /cat stats             — all-time stats',
      '  /cat compact | full    — one line or the full band',
      '  /cat hide | show       — hide the cat or bring it back',
      '  /cat cache 5 | 60      — how many minutes the cache lives (60 by default)',
      '  /cat lang en | ru      — the cat\'s language',
      '',
      'Friends online:',
      '  /cat server <url>      — friends server (your own, from server/)',
      '  /cat friend new        — open a room and get a code for a friend',
      '  /cat friend <code>     — join a room by its code',
      '  /cat friend            — which room you are in',
      '  /cat name <name>       — how friends see you',
      '  /cat color <color>     — ' + colors,
      '  /cat share on | off    — show friends what you are doing (off by default)',
      '  /cat notify on | off   — toasts when a friend comes or goes',
      '  /cat who               — who is in the room, tasks today, limits',
      '  /cat invite            — a message for a friend: how to get the cat and join',
      '  /cat preview           — show what friends look like (for 30 s)',
      '  /cat solo              — leave the room',
      '',
      'With friends:',
      '  /cat meow [name|all]   — meow at a friend: their cat jumps with a «!»',
      '  /cat say <name|all> <text> — a note over their cat for a minute',
      '  /cat mood <emoji|off>  — a badge over your cat: 🍕 ☕ 🎧 ;3 …',
      '  «pet» and 👍 🔥 😹     — buttons under a friend\'s cat',
      '',
      'Kittens: the cat gets a kitten for each agent while it works.',
    ].join('\n'),

  langNow: 'The cat speaks English. /cat lang ru switches it to Russian.',
  hidden: 'The cat is hiding. /cat show brings it back.',
  shown: 'The cat is back =^.^=',
  compacted: 'The cat curled up into one line. /cat full brings the band back.',
  cacheChoices: 'The cache lives 5 or 60 minutes: /cat cache 5 or /cat cache 60',
  cacheSet: minutes => `The cat now counts on the cache living ${minutes} min.`,
  serverIs: server => `Friends server: ${server}`,
  serverNone: 'No friends server set. Run your own from the server/ folder (see the README) and set it: /cat server http://host:9797',
  serverFirst: 'Set a friends server first. Run your own from the server/ folder (see the README) and set it: /cat server http://host:9797',
  serverBad: 'Needs an address like http://host:9797 or https://cats.example.com',
  serverSetInRoom: (server, room) => `Friends server: ${server}. You are in room «${room}».`,
  serverSet: server => `Friends server: ${server}. Now /cat friend new or /cat friend <code>.`,
  inRoom: (room, name, color) => `You are in room «${room}» as ${name} (${color}). For a friend: /cat friend ${room}`,
  noRoom: 'You are not in a room. /cat friend new opens one, /cat friend <code> joins someone else\'s.',
  joined: (room, name, color) => `You are in room «${room}» as ${name} (${color}).\nSend a friend: /cat friend ${room}`,
  nameTip: '\nTip: /cat name <name>, so friends see who you are.',
  nameNow: name => `You are «${name}» now. A new name: /cat name Whiskers`,
  nameSet: name => `Friends now see you as «${name}».`,
  colorNow: (color, colors) => `Now ${color}. Colors: ${colors}`,
  colorSet: color => `Your cat is ${color} for friends now.`,
  shareOn: 'Friends see what you are doing: «editing main.py» and so on.',
  shareOff: 'Friends see only your status, no details.',
  notifyOn: "I'll tell you when a friend comes or goes.",
  notifyOff: 'No toasts about friends.',
  previewOn: 'This is what friends look like. They disappear in 30 seconds.',
  notInRoom: 'You are not in a room. /cat friend new or /cat friend <code>',
  whoHead: (room, tasks) => `In room «${room}». You: today ${tasks}.`,
  noFriendsYet: 'No friends yet: /cat invite',
  tooOften: 'Not so often: wait a couple of seconds.',
  meowSent: names => `🐾 Meow → ${names}`,
  sayUsage: 'Like this: /cat say Kent look at the PR  (or /cat say all lunch?)',
  moodSet: emoji => `Over the cat now: ${emoji}`,
  moodOff: 'The badge over the cat is gone.',
  invite: (server, room) =>
    [
      'Send a friend:',
      '',
      `  Get the cat for Claude Code: tell your Claude Code «install the cat following ${server}/install».`,
      `  Then restart it and type /cat server ${server} and /cat friend ${room}`,
    ].join('\n'),
  solo: 'Left the room. A lone cat again.',
  roomEmpty: 'Nobody in the room yet. /cat invite',
  whom: names => `Whom? ${names} or all`,
  noSuch: names => `No such cat. In the room: ${names}`,

  limitAlmost: (name, percent) => `=^o^= The ${name} limit is almost out: ${percent}%`,
  online: name => `=^.^= ${name} is online`,
  left: name => `=-.-= ${name} left`,
  tooOftenToast: 'Not so often 🐾',
  pets: (names, isMany) => `♥ ${names} ${isMany ? 'pet' : 'pets'} your cat`,
  meows: names => `🐾 ${names}: meow!`,
  reacts: (emoji, from) => `${emoji} ${from}, for your task`,
  cacheSoon: '=^-^= The cache goes cold in 3 minutes',
  milestone: n => `=^ω^= The cat closed ${n} tasks!`,
  record: took => `=^O^= New record: ${took} on one task`,
  meowDone: 'Meow! =^ω^=',
  backToRoom: room => `=^.^= To get back to room «${room}», set the friends server: /cat server <url>`,
  commandHelp: 'The cat: stats, compact view, hide',
  preview: { kent: 'Kent', vasya: 'Vasya', liza: 'Liza', note: 'look at the PR' },
}

const WORDS: Record<Lang, Words> = { ru: RU, en: EN }
const LANG_KEY = 'lang'

// The words every hook speaks with. Each hook takes them from $.state first,
// as a reload resets module values and keeps the state.
let tr: Words = RU
const useLang = async ($: EngineInterface) => {
  tr = WORDS[await read($, lang)]
}

// The language /cat lang saved. Before that: Russian for a cat that lived
// here before it spoke English (its stats are saved), otherwise the system's.
// The first choice is saved, so the stats a new cat gathers do not flip it.
const chooseLang = async ($: EngineInterface): Promise<Lang> => {
  const saved = await $.store.get(LANG_KEY)
  if (saved === 'ru' || saved === 'en') return saved
  const chosen: Lang =
    (await $.store.get(LIFETIME_KEY)) !== undefined || Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('ru')
      ? 'ru'
      : 'en'
  await $.store.set(LANG_KEY, chosen)
  return chosen
}

const kilo = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : `${Math.round(tokens / 1000)}k`

const short = (value: unknown, max = 28) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const fileName = (value: unknown) =>
  typeof value === 'string' ? (value.split(/[\\/]/).pop() ?? value) : ''

const describe = (e: ToolCallInput) => {
  const args = e as unknown as Record<string, unknown>
  const tool: string = e.tool
  switch (tool) {
    case 'Read':
      return tr.reads(fileName(args.file_path))
    case 'Edit':
    case 'MultiEdit':
      return tr.edits(fileName(args.file_path))
    case 'Write':
      return tr.writes(fileName(args.file_path))
    case 'Bash':
    case 'PowerShell':
      return `${tr.run} ${short(args.command)}`
    case 'Grep':
      return tr.searchText(short(args.pattern, 20))
    case 'Glob':
      return tr.searchFiles(short(args.pattern, 20))
    case 'WebFetch':
    case 'WebSearch':
      return tr.web
    case 'Agent':
    case 'Task':
      return tr.agent
    case 'Skill':
      return tr.skill
    case 'AskUserQuestion':
      return tr.asks
    default:
      return tr.uses(tool.split('__').pop() ?? tool)
  }
}

// ---------- the pixel cat, shared by every surface ----------

type Palette = Record<string, number>

// A palette per fur color: o fur, d stripes/tail/paws, l muzzle/belly. The rest
// (eyes, shine, ears, nose, tear) stay the same so every cat reads the same way.
const FIXED = { k: 0x2b2b2b, w: 0xffffff, p: 0xf08aa8, n: 0xe0457b, b: 0x5aa0ff, z: 0xb8bcc4 }
const ORANGE_FUR: [number, number, number] = [0xf0a040, 0xc06f22, 0xfde3b8]
const FUR: Record<string, [number, number, number]> = {
  orange: ORANGE_FUR,
  gray: [0x9aa0a8, 0x6b7076, 0xe6e8ea],
  black: [0x44474d, 0x26282c, 0xb9bcc2],
  white: [0xf3f3f5, 0xc9ccd2, 0xffffff],
  blue: [0x5aa0ff, 0x2f6fd0, 0xd4e6ff],
  pink: [0xf58ab8, 0xd85f93, 0xffe0ee],
  green: [0x8ecb6a, 0x5d9a3c, 0xe2f4d2],
}
const COLOR_NAMES = Object.keys(FUR)
const paletteFor = (color: string): Palette => {
  const [o, d, l] = FUR[color] ?? ORANGE_FUR
  return { o, d, l, ...FIXED }
}
// Picks a stable color for a friend from their id, when the server gave none.
const colorFromId = (id: string) => {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLOR_NAMES[h % COLOR_NAMES.length] ?? 'orange'
}
const NONE = 0x01000000

// Each row is a 3-pixel tail slot followed by the rest of the cat (21 pixels).
const CAT = [
  '.............o....o..',
  '............opo..opo.',
  '............oooooooo.',
  '............oodoodoo.',
  '............owkoowko.',
  '............ollnnllo.',
  '............oolllloo.',
  '.oooodoooodoooooooo..',
  'oooodoooodooooolllo..',
  'ooooooooooooolllll...',
  'oooooooooooolllll....',
  'ooooollllllllllo.....',
  '.oooollllllllloo.....',
]
const EYES_SHUT = '............okkookko.'
const MUZZLE_TEAR = '............oblnnllo.'
const MUZZLE_BLUSH = '............pllnnllp.'
const LEGS_A = ['.oo.oo.....oo.oo.....', '.oo.oo.....oo.oo.....', '.dd.dd.....dd.dd.....']
const LEGS_B = ['oo...oo...oo...oo....', 'oo...oo...oo...oo....', 'dd...dd...dd...dd....']
// The front paw lifted to wave: drawn beside the chest instead of on the ground.
const LEGS_WAVE = ['.oo.oo.....oo........', '.oo.oo.....oo........', '.dd.dd.....dd........']
const PAW_UP: [string, string] = ['.oooollllllllloooo...', '.oooollllllllloodd...']
const TAIL_DOWN = ['...', '...', '...', '..d', '.dd', '.d.', '.d.', '.d.', '..d']
const TAIL_UP = ['...', '...', 'd..', 'd..', 'd..', '.d.', '.d.', '.d.', '..d']
const HEART = ['n.n', 'nnn', '.n.']
const ZZZ = ['zzzz', '..z.', '.z..', 'zzzz']
const QUESTION = ['www', '..w', '.w.', '...', '.w.']
const EXCLAIM = ['w', 'w', 'w', '.', 'w']
const MOON = ['.mm.', 'm...', 'm...', '.mm.']
const SUN = ['.cc.', 'cccc', 'cccc', '.cc.']
const SUNSET = ['.rr.', 'rrrr']
// Colors that are not the cat's: sun, moon, sunset, stars.
const SKY: Palette = { c: 0xf2c94c, m: 0xf4e8b0, r: 0xf08a4b, s: 0xdfe6ff }

const SPRITE_W = 24
const COLS = 48
const HEIGHT = 20 // pixels; the cat is 16 tall, the rest is room to jump

type Look = {
  mood: Mood
  isSad: boolean
  isAsleep: boolean
  isWaiting: boolean
  isPetted: boolean
  // Idle while its kittens work: it sits or lies down by them, awake.
  isWatching: boolean
}

type Gait = 'stand' | 'walk' | 'run'

// Lying down, asleep: head on the front paws, tail along the bottom. LYING_IN
// is the breath in, the back one pixel higher.
const LYING = [
  '...............o....o...',
  '..............opo..opo..',
  '..............oooooooo..',
  '.....oodooodooodoodooo..',
  '...ooodooodooookkookko..',
  '..ooooooooooooollnnllo..',
  '.ooooooooooooooolllloodd',
  '.ooooollllllllllooooddd.',
  'dddddddddddooooo........',
]
const LYING_IN = LYING.map((row, i) => (i === 2 ? '.......ooooooooooooooo..' : row))
// Lying down with the eyes open, keeping an eye on the kittens.
const LYING_AWAKE = LYING.map((row, i) => (i === 4 ? '...ooodooodoooowkoowko..' : row))
const LYING_AWAKE_IN = LYING_IN.map((row, i) => (i === 4 ? LYING_AWAKE[4]! : row))
// Sitting up, front paws together, the tail curled along the ground; SITTING_BLINK
// is its eyes row with the eyes shut.
const SITTING = [
  '...............o....o...',
  '...............opo..opo.',
  '...............oooooooo.',
  '...............oodoodoo.',
  '...............owkoowko.',
  '...............ollnnllo.',
  '.............oooolllloo.',
  '...........oooooolllll..',
  '..........oooodooollll..',
  '.........oooodoooolll...',
  '.........ooooooooolll...',
  '........oooooooooollo...',
  '........ooooooooo.oo....',
  '.......oooooooooo.oo....',
  '......doooooooooo.oo....',
  'ddddddddddddddddd.dd....',
]
const SITTING_BLINK = '...............okkookko.'

const sprite = (look: Look, n: number, gait: Gait) => {
  const rows = [...CAT]
  if (look.isPetted) {
    rows[4] = EYES_SHUT
    rows[5] = MUZZLE_BLUSH
  } else if (look.isSad) {
    rows[4] = EYES_SHUT
    rows[5] = MUZZLE_TEAR
  } else if (look.mood === 'idle' && n % 16 === 15) {
    rows[4] = EYES_SHUT
  }

  const step = gait === 'run' ? n % 2 : gait === 'walk' ? Math.floor(n / 2) % 2 : 0
  let legs = step === 1 ? LEGS_B : LEGS_A
  if (look.isWaiting && n % 4 < 2) {
    legs = LEGS_WAVE
    rows[11] = PAW_UP[0]
    rows[12] = PAW_UP[1]
  }

  const wags = gait !== 'stand' || look.isPetted ? n % 2 === 0 : n % 8 < 4
  const tail = wags ? TAIL_DOWN : TAIL_UP
  return [...rows, ...legs].map((rest, i) => (tail[i] ?? '...') + rest)
}

const flip = (rows: string[]) => rows.map(row => [...row].reverse().join(''))

const paint = (grid: number[][], rows: string[], x: number, y: number, pal: Palette) => {
  const width = grid[0]?.length ?? 0
  rows.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      const color = pal[ch]
      const px = x + dx
      const py = y + dy
      if (color !== undefined && py >= 0 && py < HEIGHT && px >= 0 && px < width) {
        grid[py]![px] = color
      }
    })
  })
}

// An awake idle cat strolls between lo and hi: sits, walks across, sits, walks
// back (24 s a lap from 2 to 18).
const stroll = (n: number, lo: number, hi: number): { x: number; gait: Gait; isLeft: boolean } => {
  const len = Math.max(0, hi - lo)
  const t = n % (64 + 2 * len)
  if (t < 32) return { x: lo, gait: 'stand', isLeft: false }
  if (t < 32 + len) return { x: lo + (t - 32), gait: 'walk', isLeft: false }
  if (t < 64 + len) return { x: hi, gait: 'stand', isLeft: false }
  return { x: hi - (t - 64 - len), gait: 'walk', isLeft: true }
}

// What goes on around one cat: a '!' after a meow, a friend chasing it,
// friends asleep in a pile with it, or a forced pose (a friend walking home).
type Scene = {
  isPoked?: boolean
  // A friend's cat running right behind this one: its colors, and the frame
  // within the chase (0 to CHASE_LEN - 1).
  chase?: { pal: Palette; t: number }
  pile?: Palette[]
  pose?: { x: number; gait: Gait; isLeft: boolean }
}

// While two cats are both busy they run across together for CHASE_LEN frames,
// every CHASE_EVERY frames, counted from when the later of the two got busy:
// each chase starts at the edge, and at about the same time on both screens.
const CHASE_EVERY = 120
const CHASE_LEN = 30
const RUNNER: Look = { mood: 'busy', isSad: false, isAsleep: false, isWaiting: false, isPetted: false, isWatching: false }

const paintSky = (grid: number[][], hour: number, n: number) => {
  // The sky keeps to the yard's top right corner.
  const r = (grid[0]?.length ?? COLS) - COLS
  if (hour >= 22 || hour < 6) {
    paint(grid, MOON, r + 43, 0, SKY)
    if (n % 8 < 6) paint(grid, ['s'], r + 38, 2, SKY)
    if ((n + 4) % 8 < 6) paint(grid, ['s'], r + 46, 7, SKY)
  } else if (hour < 11) {
    paint(grid, SUN, r + 43, 0, SKY)
  } else if (hour >= 18) {
    paint(grid, SUNSET, r + 43, 3, SKY)
  }
}

// One cat in the yard: how it looks, its colors, what goes on around it, its
// own frame (a friend's runs at an offset, so cats do not move in step), the
// spot it keeps while it is not walking, the stretch it strolls, its kittens
// and the lane they play in. A cat away (a friend's, chasing this one in this
// cat's scene) leaves its kittens to play in its lane.
type YardCat = {
  look: Look
  pal: Palette
  scene: Scene
  n: number
  home: number
  walk: [number, number]
  kits: KitView[]
  lane: [number, number]
  isAway?: boolean
}

// A busy cat runs back and forth across the whole yard, a pixel a frame.
const runAt = (n: number, track: number) => {
  const step = n % (track * 2)
  return { x: step < track ? step : track * 2 - step, isLeft: step >= track }
}

// Idle while its kittens work, a cat sits up for WATCH_TURN frames, then lies
// down awake for as long, by turns. A multiple of the kittens' KIT_ACT_LEN, so
// it turns over while a visiting kitten is back at its own spot.
const WATCH_TURN = 96
const restOf = (look: Look, scene: Scene, n: number): 'sit' | 'lie' | undefined =>
  look.isWatching && look.mood === 'idle' && !look.isPetted && !look.isWaiting && !scene.pose && !scene.isPoked
    ? Math.floor(n / WATCH_TURN) % 2 === 0
      ? 'sit'
      : 'lie'
    : undefined

const drawCat = (grid: number[][], { look, pal, scene, n, home, walk, isAway }: YardCat) => {
  if (isAway) return
  const width = grid[0]?.length ?? COLS
  const track = width - SPRITE_W
  const rest = restOf(look, scene, n)
  if (rest === 'sit') {
    paint(grid, n % 16 === 15 ? SITTING.map((row, i) => (i === 4 ? SITTING_BLINK : row)) : SITTING, home, HEIGHT - 16, pal)
    return
  }
  if (rest === 'lie') {
    const rows = n % 8 >= 4 ? LYING_AWAKE_IN : LYING_AWAKE
    paint(grid, n % 16 === 15 ? rows.map((row, i) => (i === 4 ? LYING[4]! : row)) : rows, home, HEIGHT - LYING.length, pal)
    return
  }
  if (look.isAsleep && !look.isPetted && !scene.pose) {
    const breath = (k: number) => (k % 8 >= 4 ? LYING_IN : LYING)
    const y = HEIGHT - LYING.length
    // A pile: one friend lies behind and above, this cat front left, another front right.
    const [first, second] = scene.pile ?? []
    const x = first ? 0 : home
    if (second) paint(grid, breath(n + 5), 12, y - 5, second)
    paint(grid, breath(n), x, y, pal)
    if (first) paint(grid, breath(n + 3), 24, y, first)
    const isIn = n % 8 >= 4
    paint(grid, ZZZ, first ? 2 + (isIn ? 1 : 0) : x + 24 + (isIn ? 1 : 0), 4 - (isIn ? 2 : 0), pal)
    return
  }

  let x = home
  let y = HEIGHT - 16
  let gait: Gait = 'stand'
  let isLeft = false
  const isStill = look.isWaiting || look.isSad || look.isPetted
  if (scene.pose) {
    ;({ x, gait, isLeft } = scene.pose)
  } else if (look.mood === 'busy' && !isStill) {
    if (scene.chase) {
      // A chase: this cat runs across the yard, the friend's cat right behind.
      x = -SPRITE_W + scene.chase.t * Math.ceil((width + SPRITE_W + 28) / CHASE_LEN)
      paint(grid, sprite(RUNNER, n + 1, 'run'), x - 28, y, scene.chase.pal)
    } else {
      ;({ x, isLeft } = runAt(n, track))
    }
    gait = 'run'
  } else if (look.mood === 'idle') {
    // Petting, or a kitten's agent asking the person, stops the stroll where
    // the cat is; a cat that was resting by its kittens stands up at home.
    const at = stroll(n, walk[0], walk[1])
    x = look.isWatching && (look.isWaiting || look.isPetted || scene.isPoked) ? home : at.x
    if (!look.isPetted && !look.isWaiting) {
      gait = at.gait
      isLeft = at.isLeft
    }
  }
  if (!scene.pose && !look.isPetted && (look.mood === 'done' || scene.isPoked)) {
    y = n % 2 === 0 ? 1 : HEIGHT - 16
  }

  // Hearts and marks go beside the cat, on whichever side has room.
  const side = x + SPRITE_W <= width - 10 ? x + SPRITE_W : Math.max(0, x - 10)
  if (look.isPetted) {
    paint(grid, HEART, side + (n % 2), 6 - (n % 4), pal)
    paint(grid, HEART, side + 6 - (n % 2), 9 - ((n + 2) % 4), pal)
  } else if (scene.isPoked) {
    if (n % 4 < 3) paint(grid, EXCLAIM, side + 1, 1, pal)
  } else if (look.isWaiting) {
    if (n % 4 < 3) paint(grid, QUESTION, side, 1, pal)
  } else if (look.mood === 'done') {
    paint(grid, HEART, side + 2 + (n % 3) * 2, 8 - (n % 4) * 2, pal)
    paint(grid, HEART, side + 7 - (n % 3), 10 - ((n + 2) % 4) * 2, pal)
  }

  const rows = sprite(look, n, gait)
  paint(grid, isLeft ? flip(rows) : rows, x, y, pal)
}

// ---------- kittens: one for each agent at work ----------

// A kitten is KIT_W by KIT_H pixels facing right: a 2-pixel tail slot, then the
// kitten. Crouched it sits a row lower with its legs tucked under it.
const KIT_W = 9
const KIT_H = 6
const KIT_HEAD = ['..o...o', '..ooooo']
const KIT_EYES = '..okoko'
const KIT_EYES_SHUT = '..ododo'
const KIT_MUZZLE = 'ooolnlo'
const KIT_MUZZLE_TEAR = 'ooobnlo'
const KIT_MUZZLE_BLUSH = 'ooopnpo'
const KIT_BELLY = 'ooooll.'
const KIT_LEGS_A = 'o.o.o.o'
const KIT_LEGS_B = '.o.o.o.'
const KIT_LEGS_LEAP = 'oo...oo'
const KIT_TAIL_DOWN = ['..', '..', '..', 'd.', '.d', '..']
const KIT_TAIL_UP = ['d.', 'd.', '.d', '.d', '..', '..']
const KIT_HEART = ['n.n', '.n.']
const SPARKLE_SMALL = ['.w.', 'w.w', '.w.']
const SPARKLE_BIG = ['w...w', '..w..', 'w...w']
const YARN = ['.yy.', 'yyyy', '.yy.']
const TOYS: Palette = { y: 0x6fc3df }

type KitPose = 'stand' | 'walk' | 'crouch' | 'leap'
type KitFace = 'plain' | 'blink' | 'happy' | 'sad'

const kittenSprite = (pose: KitPose, face: KitFace, n: number, isTailUp: boolean) => {
  const eyes = face === 'blink' || face === 'happy' ? KIT_EYES_SHUT : KIT_EYES
  const muzzle = face === 'sad' ? KIT_MUZZLE_TEAR : face === 'happy' ? KIT_MUZZLE_BLUSH : KIT_MUZZLE
  const legs = pose === 'leap' ? KIT_LEGS_LEAP : pose === 'walk' && n % 2 === 1 ? KIT_LEGS_B : KIT_LEGS_A
  const body = [...KIT_HEAD, eyes, muzzle, KIT_BELLY]
  const rows = pose === 'crouch' ? ['.......', ...body] : [...body, legs]
  const tail = isTailUp ? KIT_TAIL_UP : KIT_TAIL_DOWN
  return rows.map((rest, i) => (tail[i] ?? '..') + rest)
}

// One kitten as the yard draws it: `seed` picks its games and their phase,
// `age` counts frames since it came, `gone` frames since its agent finished
// (-1 while it works).
type KitView = { seed: number; age: number; status: Kitten['status']; isAsking: boolean; isSad: boolean; gone: number }
// The age of a kitten seen already grown: a friend's, which come as a count.
const KIT_GROWN = 100

const seedOf = (id: string) => {
  let h = 11
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 997
}

// A kitten's games last KIT_ACT_LEN frames each. While the cat rests, the
// kittens take turns over to it for as long, with a turn in each round that
// nobody takes, so a lone kitten plays as well.
const KIT_ACT_LEN = 48
const KIT_GAMES = ['trot', 'pounce', 'yarn', 'hop', 'spin'] as const
const HOP = [0, -1, -3, -4, -3, -1, 0, 0]
// Every KIT_ROMP_EVERY frames, a cat's kittens romp: off one way in a line and
// back (32 frames), each a little behind the one before, in the last
// KIT_ACT_LEN of them (nobody visits the cat meanwhile).
const KIT_ROMP_EVERY = 192
// A kitten coming in and going out: frames of sparkle, then a drop from above;
// a hop (or a cry), then sparkle, as it goes.
const KIT_DROP = [-6, -3, 0, -1]
const KIT_GOODBYE = 8
const KIT_GONE_FRAMES = KIT_GOODBYE + 2

// Kitten j of `count` waits its turn at a spot in the lane, the first one by
// the far end, the others back towards the cat, as close as the lane needs.
const kitSpot = (j: number, count: number, lo: number, hi: number) => {
  const room = Math.max(0, hi - lo - KIT_W - 2)
  const step = count > 1 ? Math.min(KIT_W + 2, room / (count - 1)) : 0
  return Math.round(hi - KIT_W - 1 - j * step)
}

const drawKittens = (grid: number[][], mom: YardCat) => {
  const { kits, n, pal, home, look, scene } = mom
  if (kits.length === 0) return
  const [lo, hi] = mom.lane
  const width = grid[0]?.length ?? COLS
  const ground = HEIGHT - KIT_H
  const rest = restOf(look, scene, n)
  const isMomRunning =
    look.mood === 'busy' && !look.isWaiting && !look.isSad && !look.isPetted && !scene.chase && !scene.pose && !mom.isAway
  const isMomGlad = look.mood === 'done' && !look.isPetted && !scene.pose
  const romp = (n % KIT_ROMP_EVERY) - (KIT_ROMP_EVERY - KIT_ACT_LEN)
  const isRomping = romp >= 0 && kits.length > 1
  const atWork = kits.filter(k => k.gone < 0 && k.age >= KIT_DROP.length + 2)
  const visitor = rest && !isRomping ? atWork[Math.floor(n / KIT_ACT_LEN) % (atWork.length + 1)] : undefined

  kits.forEach((k, j) => {
    const spot = kitSpot(j, kits.length, lo, hi)
    const own = n + k.seed
    let x = spot
    let y = ground
    let pose: KitPose = 'stand'
    let face: KitFace = own % 20 === 0 ? 'blink' : 'plain'
    let isLeft = false
    let isTailUp = own % 8 < 4

    if (k.age < 2) {
      paint(grid, k.age === 0 ? SPARKLE_BIG : SPARKLE_SMALL, spot + (k.age === 0 ? 2 : 3), ground + 1, pal)
      return
    }
    if (k.gone >= KIT_GOODBYE) {
      if (k.gone < KIT_GONE_FRAMES) paint(grid, k.gone === KIT_GOODBYE ? SPARKLE_SMALL : SPARKLE_BIG, spot + 2, ground + 1, pal)
      return
    }
    if (k.age < 2 + KIT_DROP.length) {
      y = ground + (KIT_DROP[k.age - 2] ?? 0)
      pose = y < ground ? 'leap' : 'stand'
    } else if (k.gone >= 0) {
      // Its agent is done: a hop and a heart, or a tear for one that failed.
      if (k.status === 'done') {
        y = ground + (HOP[k.gone % HOP.length] ?? 0)
        pose = y < ground ? 'leap' : 'stand'
        face = 'happy'
        paint(grid, KIT_HEART, x + 4, y - 3, pal)
      } else {
        face = 'sad'
        isTailUp = false
      }
    } else if (k.isAsking) {
      if (n % 4 < 3) paint(grid, QUESTION, x + 4, y - 6, pal)
    } else if (k.isSad) {
      face = 'sad'
      isTailUp = false
    } else if (isMomRunning && SPRITE_W + 4 + j * (KIT_W + 2) <= width - SPRITE_W) {
      // The cat is busy: the kittens run after it in a line, where it ran a
      // moment ago. One the yard has no room to trail plays on instead.
      const was = runAt(n - (SPRITE_W + 4 + j * (KIT_W + 2)), width - SPRITE_W)
      x = was.x + (was.isLeft ? 0 : SPRITE_W - KIT_W)
      isLeft = was.isLeft
      pose = 'walk'
    } else if (isMomGlad) {
      y = ground + (HOP[own % HOP.length] ?? 0)
      pose = y < ground ? 'leap' : 'stand'
      face = 'happy'
    } else if (isRomping) {
      // 2 frames apart, so the 8th kitten too is back at its spot as the slot ends.
      const v = romp - 2 * j
      const d = v < 0 ? 0 : v < 8 ? -2 * v : v < 16 ? -16 + 2 * (v - 8) : v < 24 ? 2 * (v - 16) : Math.max(0, 16 - 2 * (v - 24))
      x = Math.min(width - KIT_W, Math.max(0, spot + d))
      isLeft = v >= 0 && (v < 8 || v >= 24)
      pose = v >= 0 && v < 32 ? 'walk' : 'stand'
    } else if (k === visitor) {
      // Over to the resting cat: up on its back while it lies down, or
      // nuzzling its paws while it sits, a heart floating up between them.
      const u = n % KIT_ACT_LEN
      const isUp = rest === 'lie'
      const to = isUp ? home + 4 : home + 20
      const toY = isUp ? HEIGHT - LYING.length - 3 : ground
      const p = u < 12 ? (u + 1) / 12 : u < 36 ? 1 : (47 - u) / 12
      x = Math.round(spot + (to - spot) * p)
      isLeft = to < spot ? u < 36 : u >= 36
      pose = p > 0 && p < 1 ? 'walk' : 'stand'
      if (isUp && p >= 5 / 6) y = p === 1 ? toY : Math.round((ground + toY) / 2) - 2
      if (p === 1) {
        isLeft = !isUp
        face = u % 12 < 6 ? 'happy' : 'plain'
        const rise = Math.floor((u % 8) / 2)
        if (u % 8 < 6) paint(grid, KIT_HEART, isUp ? x + 4 : home + 23, (isUp ? y : ground) - 3 - rise, pal)
      }
    } else {
      const u = own % KIT_ACT_LEN
      const game = KIT_GAMES[(k.seed + Math.floor(own / KIT_ACT_LEN)) % KIT_GAMES.length]
      if (game === 'trot') {
        const v = Math.floor(u / 2) % 16
        x = spot - 4 + (v < 8 ? v : 16 - v)
        isLeft = v >= 8
        pose = 'walk'
      } else if (game === 'pounce') {
        // A crouch with the tail going, a leap, a look round; then back the other way.
        const v = u % 16
        const dir = Math.floor(u / 16) % 2 === 0 ? 1 : -1
        const from = spot - 3 * dir
        isLeft = dir < 0
        if (v < 8) {
          x = from
          pose = 'crouch'
          isTailUp = n % 2 === 0
        } else if (v < 12) {
          x = from + dir * ([2, 3, 5, 6][v - 8] ?? 6)
          y = ground + ([-2, -3, -3, -1][v - 8] ?? 0)
          pose = 'leap'
        } else {
          x = from + 6 * dir
        }
      } else if (game === 'yarn') {
        // Batting a ball of yarn: it rolls off and back, and gets a paw again.
        // By the lane's end the kitten turns round and bats it back the other way.
        const v = u % 16
        const b = Math.floor((v < 8 ? v : 16 - v) / 2)
        isLeft = spot + KIT_W + 7 > hi
        paint(grid, YARN, Math.min(width - 4, Math.max(0, isLeft ? spot - 3 - b : spot + KIT_W - 1 + b)), HEIGHT - 3, TOYS)
        x = isLeft ? spot + 1 : spot - 1
        pose = b === 0 ? 'crouch' : 'stand'
        isTailUp = n % 2 === 0
      } else if (game === 'hop') {
        y = ground + (HOP[u % HOP.length] ?? 0)
        pose = y < ground ? 'leap' : 'stand'
        isLeft = Math.floor(u / 16) % 2 === 1
      } else {
        // Chasing its own tail: round and round, then a rest.
        const v = u % 16
        if (v < 8) {
          isLeft = Math.floor(v / 2) % 2 === 1
          isTailUp = true
          pose = 'walk'
        } else if (v === 12) {
          face = 'blink'
        }
      }
    }
    const rows = kittenSprite(pose, face, n, isTailUp)
    // A game near the yard's edge would take a kitten past it.
    paint(grid, isLeft ? flip(rows) : rows, Math.min(width - KIT_W, Math.max(0, x)), y, pal)
  })
}

// The yard: every cat on one strip `width` pixels wide under the sky for the
// hour, the first cats behind, the last one in front, and every kitten in
// front of the cats.
const yard = (width: number, hour: number, n: number, cats: YardCat[]) => {
  const grid: number[][] = Array.from({ length: HEIGHT }, () => Array(width).fill(NONE))
  paintSky(grid, hour, n)
  for (const cat of cats) drawCat(grid, cat)
  for (const cat of cats) drawKittens(grid, cat)
  return grid
}

// ---------- terminal: half blocks in a Raster ----------

// The engine's runtime has Uint8Array#toBase64; TypeScript's es2023 lib does not know it yet.
const toBase64 = (bytes: Uint8Array) => (bytes as Uint8Array & { toBase64(): string }).toBase64()

const HALF = 0x2580 // ▀: foreground paints the top pixel, background the bottom
const RASTER_ROWS = HEIGHT / 2

const raster = (grid: number[][]) => {
  const cols = grid[0]?.length ?? 0
  const words = new Uint32Array(cols * RASTER_ROWS * 3)
  for (let r = 0; r < RASTER_ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3
      const top = grid[r * 2]?.[c] ?? NONE
      const bottom = grid[r * 2 + 1]?.[c] ?? NONE
      words[i] = top === NONE && bottom === NONE ? 0x20 : HALF
      words[i + 1] = top
      words[i + 2] = bottom
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// ---------- desktop: the same pixels as an SVG, one frame at a time ----------

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// One rect per horizontal run of a color keeps the markup small.
const rects = (grid: number[][]) => {
  let out = ''
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const color = row[x] ?? NONE
      let end = x + 1
      while (end < row.length && row[end] === color) end++
      if (color !== NONE) {
        out += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(color)}"/>`
      }
      x = end
    }
  })
  return out
}

// One still frame; the frame atom ticking swaps it, since the app does not play SVG animation.
const svgPicture = (grid: number[][], pixel: number) => {
  const cols = grid[0]?.length ?? 0
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols} ${HEIGHT}" width="${cols * pixel}" height="${HEIGHT * pixel}" shape-rendering="crispEdges">${rects(grid)}</svg>`
}

// The terminal draws friends as one line each: a face in their fur color.
const FRIEND_FACE: Record<Friend['status'], string> = {
  busy: '=^o^=',
  waiting: '=^?^=',
  done: '=^ω^=',
  idle: '=-.-=',
}

// A friend's cat sleeps once it has been idle a minute, unless its kittens are at work.
const isFriendAsleep = (f: Friend) => f.status === 'idle' && f.kits === 0 && f.statusSeconds * 1000 > SLEEP_AFTER_MS

// How a friend's cat looks, from what the server says about them.
const friendLook = (f: Friend, isPetted: boolean): Look => ({
  mood: f.status === 'waiting' ? 'busy' : f.status,
  isSad: false,
  isAsleep: isFriendAsleep(f),
  isWaiting: f.status === 'waiting',
  isPetted,
  isWatching: f.status === 'idle' && f.kits > 0,
})

const friendWord = (f: Friend) => (isFriendAsleep(f) ? tr.asleep : tr.status[f.status])

// A friend's kittens at the end of a line about them, after what it says of the friend.
const friendKitsNote = (f: Friend) => (f.kits > 0 ? ` · ${tr.kittens(f.kits)}` : '')

// Each friend's animation runs at its own offset, so cats do not move in step.
const phaseOf = (id: string) => {
  let h = 7
  for (const ch of id) h = (h * 33 + ch.charCodeAt(0)) >>> 0
  return h % 96
}

const FRIEND_STATUS_COLOR: Record<Friend['status'], string> = {
  busy: GREEN,
  waiting: YELLOW,
  done: '#c678dd',
  idle: GRAY,
}

// ---------- what the cat says ----------

// `kits`: this cat's kittens at work.
const caption = (look: Look, doing: string, turn: TurnStats, now: number, kits: number) => {
  const withKits = (facts: string[]) => (kits > 0 ? [...facts, tr.kittens(kits)] : facts).join(' · ')
  if (look.isPetted) {
    return { main: tr.purr, facts: '' }
  }
  if (look.isWaiting) {
    return { main: tr.waitingForYou, facts: doing }
  }
  if (look.mood === 'busy') {
    const elapsed = Math.max(0, Math.round((now - turn.startedAt) / 1000))
    const facts = [tr.duration(elapsed), tr.actions(turn.tools)]
    if (turn.errors > 0) facts.push(tr.errors(turn.errors))
    return { main: look.isSad ? tr.oops : doing || tr.thinking, facts: withKits(facts) }
  }
  if (look.mood === 'done') {
    const facts = [tr.duration(turn.seconds), tr.actions(turn.tools)]
    if (turn.errors > 0) facts.push(tr.errors(turn.errors))
    return { main: tr.done, facts: withKits(facts) }
  }
  const last =
    turn.startedAt > 0 ? tr.lastTime(tr.duration(turn.seconds), tr.actions(turn.tools)) : ''
  if (kits > 0) return { main: tr.atWork(tr.kittens(kits)), facts: last }
  return { main: look.isAsleep ? tr.sleeping : tr.idle, facts: last }
}

// ---------- meters: limits, context, cache, cost ----------

// One row of the meters: a name, a fill from 0 to 100 (null draws no bar), the value, a note.
type Meter = {
  kind: string
  name: string
  fill: number | null
  value: string
  color: string
  note: string
}

const textBar = (percent: number, width = 10) => {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const BAR_W = 72
const BAR_H = 6
const svgBar = (percent: number, color: string, w = BAR_W) => {
  const filled = Math.min(w, Math.max(0, (percent / 100) * w))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${BAR_H}" viewBox="0 0 ${w} ${BAR_H}"><rect width="${w}" height="${BAR_H}" rx="3" fill="#7f848e" fill-opacity="0.25"/>${filled > 0 ? `<rect width="${Math.max(BAR_H, filled).toFixed(1)}" height="${BAR_H}" rx="3" fill="${color}"/>` : ''}</svg>`
}

const untilReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes >= 24 * 60) return tr.resetDays(Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60))
  if (minutes >= 60) return tr.resetHours(Math.floor(minutes / 60), minutes % 60)
  return tr.resetMinutes(minutes)
}

// A friend's 5-hour limit: a short bar, drawn the same everywhere a friend is.
const FRIEND_BAR_W = 36
const DESKTOP_FRIEND_BAR_CELLS = 5

const usedColor = (percent: number, warn = 70, alarm = 90) =>
  percent >= alarm ? RED : percent >= warn ? YELLOW : GREEN

const limitMeters = (readings: LimitReading[], now: number): Meter[] =>
  readings.map(limit => ({
    kind: limit.kind,
    name: tr.limits[limit.kind] ?? limit.kind,
    fill: limit.percentUsed,
    value: `${Math.round(limit.percentUsed)}%`,
    color: usedColor(limit.percentUsed),
    note: untilReset(limit.resetsAt, now),
  }))

// With a compaction window set, the context fills against it, as the app's own
// meter does: a 500k window on a 1M model is full at 500k.
const contextMeter = (reading: ContextReading | null, compactAt: number | null): Meter | undefined => {
  if (reading === null || reading.percent === undefined) {
    return undefined
  }
  const { tokens } = reading
  const window = compactAt ?? reading.window
  const percent = compactAt === null || tokens === undefined ? reading.percent : Math.round((tokens / compactAt) * 100)
  return {
    kind: 'context',
    name: tr.context,
    fill: percent,
    value: `${percent}%`,
    color: usedColor(percent, 60, 80),
    note: tokens === undefined ? '' : `${kilo(tokens)} / ${kilo(window)}`,
  }
}

const clockText = (ms: number) => {
  const total = Math.ceil(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

const cacheMeter = (lastAt: number, isBusy: boolean, now: number, ttlMs: number): Meter | undefined => {
  if (isBusy) {
    return { kind: 'cache', name: tr.cache, fill: 100, value: tr.warm, color: GREEN, note: '' }
  }
  if (lastAt === 0) {
    return undefined
  }
  const left = lastAt + ttlMs - now
  if (left <= 0) {
    return { kind: 'cache', name: tr.cache, fill: 0, value: tr.cold, color: GRAY, note: tr.rewrites }
  }
  const minutes = left / 60_000
  return {
    kind: 'cache',
    name: tr.cache,
    fill: (left / ttlMs) * 100,
    value: clockText(left),
    color: minutes < 3 ? RED : minutes < 10 ? YELLOW : GREEN,
    note: tr.untilCold,
  }
}

// On a subscription the dollars are what the session would cost on the API, not a bill.
const costMeter = (usd: number | null, isSubscription: boolean): Meter | undefined =>
  usd === null
    ? undefined
    : {
        kind: 'cost',
        name: tr.cost,
        fill: null,
        value: `${isSubscription ? '≈' : ''}$${usd.toFixed(2)}`,
        color: GRAY,
        note: isSubscription ? tr.apiPrices : tr.perSession,
      }

const shortMeter = (m: Meter) => `${m.name} ${m.value}`

const EMPTY_BAR = `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}"></svg>`

// Column widths in cells, fixed so nothing shifts when a value changes length.
const CAPTION_W = 26
const NAME_W = 9
const VALUE_W = 8
const NOTE_W = 18
// The desktop sizes pictures in CSS pixels and boxes in cells. Its cell is
// about 8.7 CSS px and the yard is drawn 2 CSS px a pixel, so a box of n cells
// holds a yard 4n pixels wide (8 CSS px a cell keeps the picture inside its
// box): one cat's 48 pixels in 12 cells, the bars' 72 CSS px in 9.
const DESKTOP_CAT_W = 12
const DESKTOP_BAR_W = 9
const DESKTOP_YARD_PX = 4
// Cells the yard grows by for each friend in it, up to MAX_FRIENDS_SHOWN; a
// terminal cell is one pixel wide.
const YARD_PER_FRIEND = { terminal: 36, desktop: 12 }
const MAX_FRIENDS_SHOWN = 3

const keepLimits = (readings: readonly LimitReading[]) =>
  readings.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

const keepContext = (reading: { percent?: number; tokens?: number; window: number }) => ({
  percent: reading.percent,
  tokens: reading.tokens,
  window: reading.window,
})

// The window auto-compaction runs against (CLAUDE_CODE_AUTO_COMPACT_WINDOW, the
// autoCompactWindow setting, or the engine's default for the model), or null when
// auto-compaction is off. Only the breakdown carries it; a 'summary' one is estimated locally and
// sends nothing. A /model or /config change lands between turns, so a read at
// each turn's start keeps up.
const readCompactWindow = async ($: EngineInterface) => {
  const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
  if (breakdown === undefined) return
  await update($, compactWindow, () => (breakdown.isAutoCompactEnabled ? breakdown.rawMaxTokens : null))
}

// ---------- lifetime stats ----------

const readLifetime = async ($: EngineInterface): Promise<Lifetime> => {
  const saved = (await $.store.get(LIFETIME_KEY)) as Partial<Lifetime> | undefined
  return {
    tasks: saved?.tasks ?? 0,
    tools: saved?.tools ?? 0,
    errors: saved?.errors ?? 0,
    longestSeconds: saved?.longestSeconds ?? 0,
    kittens: saved?.kittens ?? 0,
  }
}

// ---------- hooks ----------

// Timers and the line's timing live at module level: a reload starts them over.
let doneTimer: { cancel: () => void } | undefined
let sadTimer: { cancel: () => void } | undefined
let cacheWarnTimer: { cancel: () => void } | undefined
let pendingLine: { cancel: () => void } | undefined
let shownAt = 0
const warned = new Set<string>()

// Shows `text` now, or once the current line has had its HOLD_MS; the latest text wins.
const show = async ($: EngineInterface, text: string) => {
  pendingLine?.cancel()
  const now = await $.clock.now()
  const wait = shownAt + HOLD_MS - now
  if (wait <= 0) {
    shownAt = now
    await update($, activity, () => text)
    return
  }
  pendingLine = $.clock.after(wait, () => {
    shownAt = now + wait
    void update($, activity, () => text)
  })
}

const warnLimits = ($: EngineInterface, readings: readonly LimitReading[]) => {
  for (const limit of readings) {
    const name = tr.limits[limit.kind] ?? limit.kind
    if (limit.percentUsed >= LIMIT_WARN_PERCENT && !warned.has(limit.kind)) {
      warned.add(limit.kind)
      $.ui.toast(tr.limitAlmost(name, Math.round(limit.percentUsed)))
    } else if (limit.percentUsed < LIMIT_WARN_PERCENT - 10) {
      warned.delete(limit.kind)
    }
  }
}

const runCommand = async ($: EngineInterface, args: string) => {
  await useLang($)
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const v = verb.toLowerCase()
  const param = rest.join(' ').trim()
  const isOn = (word: string) => ['on', 'вкл', 'да', 'yes'].includes(word.toLowerCase())

  if (['hide', 'спрятать'].includes(v)) {
    await update($, view, () => 'hidden')
    return { text: tr.hidden }
  }
  if (['show', 'показать', 'full', 'полный'].includes(v)) {
    await update($, view, () => 'full')
    return { text: tr.shown }
  }
  if (['compact', 'компакт'].includes(v)) {
    await update($, view, () => 'compact')
    return { text: tr.compacted }
  }
  if (['stats', 'статистика'].includes(v)) {
    return { text: tr.lifetime(await readLifetime($)) }
  }
  if (['cache', 'кеш'].includes(v)) {
    const minutes = Number(param)
    if (minutes !== 5 && minutes !== 60) return { text: tr.cacheChoices }
    await $.store.set(SETTINGS_KEY, { cacheMinutes: minutes })
    await update($, cacheMinutes, () => minutes)
    return { text: tr.cacheSet(minutes) }
  }
  if (['lang', 'language', 'язык'].includes(v)) {
    const next = param.toLowerCase()
    if (next === 'ru' || next === 'en') {
      await $.store.set(LANG_KEY, next)
      await update($, lang, () => next)
      tr = WORDS[next]
    }
    return { text: tr.langNow }
  }

  // ---- friends ----
  const cfg = await readConfig($)

  if (['server', 'сервер'].includes(v)) {
    if (!param) {
      return {
        text: cfg.server
          ? tr.serverIs(cfg.server)
          : tr.serverNone,
      }
    }
    const server = serverAddress(param)
    if (server === undefined) return { text: tr.serverBad }
    if (joinedRoom(cfg) && cfg.server !== server) await leave($, cfg)
    const next = await saveConfig($, { server })
    knownFriends = null
    await update($, friends, () => [])
    await update($, link, () => ({ room: joinedRoom(next), status: joinedRoom(next) ? 'ok' : 'off' }))
    await beat($, await myStatus($), await read($, activity))
    return {
      text: next.room
        ? tr.serverSetInRoom(server, next.room)
        : tr.serverSet(server),
    }
  }
  if (['friend', 'room', 'комната', 'друг'].includes(v)) {
    if (!param) {
      return {
        text: joinedRoom(cfg)
          ? tr.inRoom(cfg.room, cfg.name, cfg.color)
          : tr.noRoom,
      }
    }
    if (!cfg.server) return { text: tr.serverFirst }
    const room = ['new', 'новая'].includes(param.toLowerCase()) ? newRoomCode() : param.slice(0, 64)
    if (cfg.room && cfg.room !== room) await leave($, cfg)
    await saveConfig($, { room })
    knownFriends = null
    await update($, friends, () => [])
    await beat($, await myStatus($), await read($, activity))
    const named = cfg.name === RU.catName || cfg.name === EN.catName ? tr.nameTip : ''
    return { text: `${tr.joined(room, cfg.name, cfg.color)}${named}` }
  }
  if (['name', 'имя'].includes(v)) {
    if (!param) return { text: tr.nameNow(cfg.name) }
    const next = await saveConfig($, { name: param.slice(0, 24) })
    void beat($, await myStatus($), await read($, activity))
    return { text: tr.nameSet(next.name) }
  }
  if (['color', 'цвет'].includes(v)) {
    const c = param.toLowerCase()
    if (!COLOR_NAMES.includes(c)) return { text: tr.colorNow(cfg.color, COLOR_NAMES.join(', ')) }
    await saveConfig($, { color: c })
    void beat($, await myStatus($), await read($, activity))
    return { text: tr.colorSet(c) }
  }
  if (v === 'share') {
    const on = isOn(param)
    await saveConfig($, { share: on })
    return { text: on ? tr.shareOn : tr.shareOff }
  }
  if (['notify', 'уведомления'].includes(v)) {
    const on = isOn(param)
    await saveConfig($, { notify: on })
    return { text: on ? tr.notifyOn : tr.notifyOff }
  }
  if (['preview', 'превью', 'демо'].includes(v)) {
    previewUntil = (await $.clock.now()) + PREVIEW_MS
    await update($, friends, list => [...list.filter(f => !f.id.startsWith('preview-')), ...previewFriends()])
    $.clock.after(PREVIEW_MS, () => {
      void update($, friends, list => list.filter(f => !f.id.startsWith('preview-')))
    })
    return { text: tr.previewOn }
  }
  if (['who', 'кто'].includes(v)) {
    if (!joinedRoom(cfg)) return { text: tr.notInRoom }
    const list = liveFriends(await read($, friends)).filter(f => !f.id.startsWith('preview-'))
    const mine = await todayCount($)
    const line = (f: Friend) =>
      `  ${f.name}${f.mood ? ` ${f.mood}` : ''} — ${friendWord(f)}${f.doing ? ` (${f.doing})` : ''}` +
      ` · ${tr.today(tr.tasks(f.today))}${f.limit5 === null ? '' : ` · ${tr.limits.five_hour} ${Math.round(f.limit5)}%`}` +
      `${f.sessions > 1 ? ` · ${tr.sessions(f.sessions)}` : ''}${friendKitsNote(f)}`
    const head = tr.whoHead(cfg.room, tr.tasks(mine))
    return { text: list.length === 0 ? `${head}\n${tr.noFriendsYet}` : `${head}\n${list.map(line).join('\n')}` }
  }
  if (['meow', 'мяу'].includes(v)) {
    const targets = pickFriends(liveFriends(await read($, friends)), param)
    if (typeof targets === 'string') return { text: targets }
    const sent = await Promise.all(targets.map(f => poke($, f.id, 'meow')))
    if (sent.every(r => r === 'slow')) return { text: tr.tooOften }
    return { text: tr.meowSent(targets.map(f => f.name).join(', ')) }
  }
  if (['say', 'скажи', 'записка'].includes(v)) {
    const [who = '', ...words] = param.split(/\s+/)
    const text = words.join(' ').trim()
    if (!who || !text) return { text: tr.sayUsage }
    const targets = pickFriends(liveFriends(await read($, friends)), who)
    if (typeof targets === 'string') return { text: targets }
    const sent = await Promise.all(targets.map(f => poke($, f.id, 'say', text.slice(0, 60))))
    if (sent.every(r => r === 'slow')) return { text: tr.tooOften }
    return { text: `💬 → ${targets.map(f => f.name).join(', ')}: ${text.slice(0, 60)}` }
  }
  if (['mood', 'настроение'].includes(v)) {
    // A whole emoji (skin tones, flags and joined emoji are several code
    // points) or a short face like ;3, not just the first code point.
    const emoji = ['off', 'нет', ''].includes(param.toLowerCase())
      ? ''
      : [...(param.split(/\s+/)[0] ?? '')].slice(0, MOOD_MAX).join('')
    await saveConfig($, { mood: emoji })
    void beat($, await myStatus($), await read($, activity))
    return { text: emoji ? tr.moodSet(emoji) : tr.moodOff }
  }
  if (['invite', 'пригласить'].includes(v)) {
    if (!cfg.server) return { text: tr.serverFirst }
    let room = cfg.room
    if (!room) {
      room = newRoomCode()
      await saveConfig($, { room })
      knownFriends = null
      await beat($, await myStatus($), await read($, activity))
    }
    return { text: tr.invite(cfg.server, room) }
  }
  if (['solo', 'выйти', 'leave'].includes(v)) {
    if (joinedRoom(cfg)) await leave($, cfg)
    await saveConfig($, { room: '' })
    knownFriends = null
    await update($, friends, () => [])
    await update($, link, () => ({ room: '', status: 'off' }))
    return { text: tr.solo }
  }

  return { text: `${tr.lifetime(await readLifetime($))}\n\n${tr.help(COLOR_NAMES.join(', '))}` }
}

// Friends who are really here (not walking home).
const liveFriends = (list: Friend[]) => list.filter(f => f.leftAt === undefined)

// Whom a command means: 'all', a name or its start, or the only friend there is.
const pickFriends = (list: Friend[], query: string): Friend[] | string => {
  if (list.length === 0) return tr.roomEmpty
  const q = query.trim().toLowerCase()
  if (!q) return list.length === 1 ? list : tr.whom(list.map(f => f.name).join(', '))
  if (['all', 'все', 'всем'].includes(q)) return list
  const found = list.filter(f => f.name.toLowerCase().startsWith(q))
  return found.length > 0 ? found : tr.noSuch(list.map(f => f.name).join(', '))
}

const pet = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, pettedUntil, () => at + PET_MS)
}

// The server is whichever one the person set, so what it sends is checked
// field by field: text is cut to the lengths our server keeps, without
// control characters, and a field of the wrong type takes its default.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const serverText = (v: unknown, max: number, fallback: string) =>
  typeof v === 'string' ? [...v.replace(/\p{Cc}/gu, '')].slice(0, max).join('') : fallback
const FRIEND_STATUSES: readonly string[] = ['idle', 'busy', 'waiting', 'done'] satisfies FriendStatus[]
const isFriendStatus = (v: unknown): v is FriendStatus => typeof v === 'string' && FRIEND_STATUSES.includes(v)

// A member as the server sent it, with every field filled in.
const asFriend = (f: Record<string, unknown>): Friend => ({
  id: serverText(f.id, 64, ''),
  self: f.self === true,
  name: serverText(f.name, 24, tr.catName),
  color: serverText(f.color, 16, 'orange'),
  status: isFriendStatus(f.status) ? f.status : 'idle',
  doing: serverText(f.doing, 40, ''),
  sessions: isNumber(f.sessions) ? f.sessions : 1,
  secondsAgo: isNumber(f.secondsAgo) ? f.secondsAgo : 0,
  statusSeconds: isNumber(f.statusSeconds) ? f.statusSeconds : 0,
  mood: serverText(f.mood, MOOD_MAX, ''),
  today: isNumber(f.today) ? f.today : 0,
  limit5: isNumber(f.limit5) ? f.limit5 : null,
  bubble: isRecord(f.bubble) ? { from: serverText(f.bubble.from, 24, ''), text: serverText(f.bubble.text, 60, '') } : null,
  kits: isNumber(f.kits) ? Math.min(MAX_KITS, Math.max(0, Math.floor(f.kits))) : 0,
})

const LEAVE_MS = 4000
const POKE_MS = 4000

type CatEvent = { kind: 'pet' | 'meow' | 'react' | 'say'; from: string; text?: string }
const EVENT_KINDS: readonly string[] = ['pet', 'meow', 'react', 'say'] satisfies CatEvent['kind'][]
const isEventKind = (v: unknown): v is CatEvent['kind'] => typeof v === 'string' && EVENT_KINDS.includes(v)

// An event as the server sent it, or none when it is not one of ours.
const asEvent = (e: Record<string, unknown>): CatEvent[] =>
  isEventKind(e.kind) ? [{ kind: e.kind, from: serverText(e.from, 24, ''), text: serverText(e.text, 60, '') }] : []

// The mood the cat is in right now. 'done' ends DONE_MS after the turn did, by
// the clock rather than by a timer: a reload of the mod drops its timers but
// keeps $.state, so a timer alone would leave the cat celebrating for good.
const settledMood = (raw: Mood, turn: TurnStats, now: number): Mood =>
  raw === 'done' && now - (turn.startedAt + turn.seconds * 1000) > DONE_MS ? 'idle' : raw

// Whether a kitten's agent waits on the person: the cat asks along.
const isKittenAsking = (list: Kitten[]) => list.some(k => isAtWork(k) && k.isAsking)

// Current status for the friends server, derived from mood + waiting.
const myStatus = async ($: EngineInterface): Promise<Friend['status']> => {
  const m = settledMood(await read($, mood), await read($, stats), await $.clock.now())
  if (isKittenAsking(await read($, kittens))) return 'waiting'
  if (m === 'busy') return (await read($, isWaiting)) ? 'waiting' : 'busy'
  return m === 'done' ? 'done' : 'idle'
}

// Fake friends for /cat preview, so the layout can be seen without a second machine.
const PREVIEW_MS = 30_000
const PREVIEW_BASE = { self: false, sessions: 1, secondsAgo: 0, mood: '', today: 0, limit5: null, bubble: null, kits: 0 }
const previewFriends = (): Friend[] => [
  { ...PREVIEW_BASE, id: 'preview-1', name: tr.preview.kent, color: 'blue', status: 'busy', doing: tr.edits('main.py'), statusSeconds: 5, today: 7, limit5: 64, mood: '☕', kits: 2 },
  { ...PREVIEW_BASE, id: 'preview-2', name: tr.preview.vasya, color: 'gray', status: 'idle', doing: '', statusSeconds: 300, today: 2, limit5: 12, bubble: { from: tr.preview.kent, text: tr.preview.note } },
  { ...PREVIEW_BASE, id: 'preview-3', name: tr.preview.liza, color: 'pink', status: 'done', doing: '', statusSeconds: 1, today: 4, limit5: 93 },
]
let previewUntil = 0

// This session's key on the server: one person may run several sessions.
let sessionKey = 'main'
// When the last beat brought the room back: friends' statusSeconds count to it.
let syncedAt = 0

// What friends see of the activity line under /cat share on: a command's
// program but not its arguments or variables, that a search runs but not what
// it looks for. File names stay, as /cat share promises.
const forFriends = (doing: string) => {
  // A line written before /cat lang switched is in the other language, so both are stripped.
  for (const words of [RU, EN]) {
    if (doing.startsWith(`${words.run} `)) {
      const program = doing.slice(words.run.length + 1).split(' ').find(w => w !== '' && !w.includes('='))
      return program ? `${words.run} ${fileName(program.replace(/…$/, ''))}` : words.runCommand
    }
    if (doing.startsWith(words.search)) return words.search
  }
  return doing
}

// Who was online at the last beat (null before the first one: no toasts for it).
let knownFriends: Map<string, string> | null = null

const announce = ($: EngineInterface, members: Friend[], notify: boolean) => {
  const next = new Map(members.map(f => [f.id, f.name] as [string, string]))
  if (knownFriends !== null && notify) {
    for (const [id, name] of next) if (!knownFriends.has(id)) $.ui.toast(tr.online(name))
    for (const [id, name] of knownFriends) if (!next.has(id)) $.ui.toast(tr.left(name))
  }
  knownFriends = next
}

// One heartbeat: tells the server where this cat is and pulls the room back.
// A beat asked for while one is in flight runs right after it, with fresh status.
let beating = false
let beatAgain = false
const beat = async ($: EngineInterface, status: Friend['status'], doing: string) => {
  const cfg = await readConfig($)
  if (!joinedRoom(cfg)) return
  if (beating) {
    beatAgain = true
    return
  }
  beating = true
  try {
    const litter = await read($, kittens)
    const fiveHour = (await read($, limits)).find(l => l.kind === 'five_hour')
    const res = await $.http.fetch(`${cfg.server}/beat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        room: cfg.room,
        id: await machineId($),
        session: sessionKey,
        name: cfg.name,
        color: cfg.color,
        // A kitten's agent waiting on the person makes the cat wait, whatever the turn says.
        status: isKittenAsking(litter) ? 'waiting' : status,
        doing: cfg.share ? forFriends(doing).slice(0, 40) : '',
        mood: cfg.mood,
        today: await todayCount($),
        limit5: fiveHour?.percentUsed ?? null,
        limit5ResetsAt: fiveHour?.resetsAt ?? null,
        kits: litter.filter(isAtWork).length,
      }),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body: unknown = JSON.parse(res.text)
    const listOf = (key: string) => (isRecord(body) && Array.isArray(body[key]) ? body[key].filter(isRecord) : [])
    const members = listOf('members').map(asFriend)
    const others = members.filter(f => !f.self)
    await update($, me, () => members.find(f => f.self) ?? null)
    await receiveEvents($, listOf('events').flatMap(asEvent))

    // A friend who left walks off for LEAVE_MS before they disappear.
    const t = await $.clock.now()
    syncedAt = t
    const here = new Set(others.map(f => f.id))
    const before = await read($, friends)
    const leaving = before
      .filter(f => !f.id.startsWith('preview-') && !here.has(f.id))
      .filter(f => f.leftAt === undefined || t - f.leftAt < LEAVE_MS)
      .map(f => (f.leftAt === undefined ? { ...f, leftAt: t } : f))
    if (leaving.some(f => f.leftAt === t)) {
      $.clock.after(LEAVE_MS + 100, () => {
        void (async () => {
          const at = await $.clock.now()
          await update($, friends, list => list.filter(f => f.leftAt === undefined || at - f.leftAt < LEAVE_MS))
        })()
      })
    }

    announce($, others, cfg.notify)
    const isPreview = previewUntil > t
    await update($, friends, () => [...others, ...leaving, ...(isPreview ? previewFriends() : [])])
    await update($, link, () => ({ room: cfg.room, status: 'ok' }))
  } catch {
    // Server unreachable: keep the last known friends, say so, try again next tick.
    await update($, link, () => ({ room: cfg.room, status: 'down' }))
  } finally {
    beating = false
  }
  if (beatAgain) {
    beatAgain = false
    await beat($, await myStatus($), await read($, activity))
  }
}

// Sends a poke to a friend's cat; it reaches them at their next beat.
// Resolves to 'ok', 'slow' (too soon after the last one) or 'fail'.
const poke = async ($: EngineInterface, to: string, kind: CatEvent['kind'], text = '') => {
  const cfg = await readConfig($)
  if (!joinedRoom(cfg) || to.startsWith('preview-')) return 'ok'
  try {
    const res = await $.http.fetch(`${cfg.server}/poke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: cfg.room, id: await machineId($), to, kind, text }),
    })
    return res.ok ? 'ok' : res.status === 429 ? 'slow' : 'fail'
  } catch {
    return 'fail'
  }
}

// Pets a friend's cat: hearts here at once, and the friend's own cat purrs at their next beat.
const petFriend = async ($: EngineInterface, id: string) => {
  const at = await $.clock.now()
  await update($, pettedFriends, map => ({ ...map, [id]: at + PET_MS }))
  await poke($, id, 'pet')
}

const REACTIONS = ['👍', '🔥', '😹']
const PILE_AFTER_MS = 10 * 60_000

const meowFriend = async ($: EngineInterface, id: string, name: string) => {
  const sent = await poke($, id, 'meow')
  $.ui.toast(sent === 'slow' ? tr.tooOftenToast : tr.meowSent(name))
}

const reactTo = async ($: EngineInterface, id: string, name: string, emoji: string) => {
  const sent = await poke($, id, 'react', emoji)
  if (sent === 'ok') $.ui.toast(`${emoji} → ${name}`)
}

// What friends sent since the last beat.
const receiveEvents = async ($: EngineInterface, events: CatEvent[]) => {
  if (events.length === 0) return
  const at = await $.clock.now()
  const petters = [...new Set(events.filter(e => e.kind === 'pet').map(e => e.from))]
  if (petters.length > 0) {
    await update($, pettedUntil, () => at + PET_MS)
    $.ui.toast(tr.pets(petters.join(', '), petters.length > 1))
  }
  const meowers = [...new Set(events.filter(e => e.kind === 'meow').map(e => e.from))]
  if (meowers.length > 0) {
    await update($, pokedUntil, () => at + POKE_MS)
    $.ui.toast(tr.meows(meowers.join(', ')))
  }
  for (const e of events) {
    if (e.kind === 'react') $.ui.toast(tr.reacts(e.text ?? '', e.from))
    if (e.kind === 'say') $.ui.toast(`💬 ${e.from}: ${e.text ?? ''}`)
  }
}

// ---------- kittens: following this session's agents ----------

// How often $.agent.list is asked who is at work. Events bring kittens in and
// out at once; the poll catches what no event told.
const KIT_POLL_MS = 2000
// A kitten whose agent has said nothing this long, with no tool of its
// running, is taken for gone. Its turn.complete always comes, so this only
// guards against one that was missed.
const KIT_QUIET_MS = 30 * 60_000
// A finished kitten is kept at least this long, and for as long as the list
// still shows its agent winding down, so the poll does not bring it back.
const KIT_FORGET_MS = 60_000
const KIT_LEAVE_MS = KIT_GONE_FRAMES * TICK_MS
const MAX_KITS_SHOWN = 8
// As many as the friends server keeps for one person.
const MAX_KITS = 20
const KIT_SAD_MS = 2500

// Tool calls in flight per agent: an agent in a long command is not quiet.
// A module value, so a reload forgets it; at worst a quiet kitten leaves early.
const toolsRunning = new Map<string, number>()

const isAtWork = (k: Kitten) => k.endedAt === 0
// $.agent.list statuses of an agent at work. 'waiting' is one held on its own
// background work or child agent: still at work if its run is going, but no
// reason to bring a kitten in.
const isListedAtWork = (status: string | undefined) => status === 'pending' || status === 'running' || status === 'waiting'
const isListedStarting = (status: string | undefined) => status === 'pending' || status === 'running'

const newKitten = (id: string, now: number, isListed: boolean): Kitten => ({
  id,
  bornAt: now,
  status: 'running',
  isAsking: false,
  endedAt: 0,
  sadUntil: 0,
  seenAt: now,
  isListed,
  hasRested: false,
})

// An agent run starting (agent.spawn, SubagentStart): its kitten comes, or
// comes back for an agent resumed after it finished.
const bringKitten = async ($: EngineInterface, id: string) => {
  const now = await $.clock.now()
  await update($, kittens, list => {
    const old = list.find(k => k.id === id)
    if (old === undefined) return [...list, newKitten(id, now, false)]
    if (isAtWork(old)) return list
    return list.map(k => (k.id === id ? newKitten(id, now, old.isListed) : k))
  })
}

// Changes a kitten at work, if there is one for that agent.
const changeKitten = async ($: EngineInterface, id: string, change: (k: Kitten) => Kitten) => {
  await update($, kittens, list => list.map(k => (k.id === id && isAtWork(k) ? change(k) : k)))
}

// Every change to the lifetime stats goes through one queue: agents and the
// turn finish at the same moment, and each change reads what the last wrote.
let lifetimeQueue: Promise<unknown> = Promise.resolve()
const changeLifetime = ($: EngineInterface, change: (life: Lifetime) => Lifetime) => {
  const run = lifetimeQueue.then(async () => {
    const before = await readLifetime($)
    const after = change(before)
    await $.store.set(LIFETIME_KEY, after)
    return { before, after }
  })
  // The queue goes on after a failed change; the caller still sees the failure.
  lifetimeQueue = run.catch(() => undefined)
  return run
}

const finish = (k: Kitten, isDone: boolean, now: number): Kitten => ({
  ...k,
  status: isDone ? 'done' : 'failed',
  endedAt: now,
  isAsking: false,
})

// Kittens grown up (agents that finished their work) go to the lifetime
// stats, and the cat's nap counts from now.
const kittensFinished = async ($: EngineInterface, grown: number, now: number) => {
  await update($, kittensDoneAt, () => now)
  if (grown > 0) await changeLifetime($, life => ({ ...life, kittens: life.kittens + grown }))
}

// An agent's run ended: its kitten says goodbye and goes.
const retireKitten = async ($: EngineInterface, id: string, isDone: boolean) => {
  const now = await $.clock.now()
  let isRetired = false
  await update($, kittens, list => {
    isRetired = false
    return list.map(k => {
      if (k.id !== id || !isAtWork(k)) return k
      isRetired = true
      return finish(k, isDone, now)
    })
  })
  toolsRunning.delete(id)
  if (isRetired) await kittensFinished($, isDone ? 1 : 0, now)
}

// Squares the kittens with $.agent.list: a listed agent starting has a kitten,
// a listed kitten whose agent is no longer at work goes, and a finished
// kitten is forgotten once its agent is done winding down.
const syncKittens = async ($: EngineInterface) => {
  const agents = await $.agent.list()
  const now = await $.clock.now()
  const statusOf = new Map(agents.map(a => [a.id, a.status]))
  const teammates = new Set(agents.filter(a => a.teammateId !== undefined).map(a => a.id))
  let grown = 0
  let ended = 0
  await update($, kittens, list => {
    grown = 0
    ended = 0
    const kept = list.filter(k => isAtWork(k) || now - k.endedAt < KIT_FORGET_MS || isListedAtWork(statusOf.get(k.id)))
    const next = kept.map((k): Kitten => {
      const status = statusOf.get(k.id)
      if (!isAtWork(k)) {
        // A teammate back at work after the list showed it resting: its next
        // turn. Any other agent's new run comes with SubagentStart.
        if (teammates.has(k.id) && k.hasRested && isListedStarting(status)) return newKitten(k.id, now, true)
        return k.isListed && !k.hasRested && !isListedStarting(status) ? { ...k, hasRested: true } : k
      }
      if (isListedAtWork(status)) return { ...k, isListed: true }
      if (k.isListed) {
        const isDone = status === undefined || status === 'completed' || status === 'idle'
        ended++
        if (isDone) grown++
        return { ...finish(k, isDone, now), hasRested: true }
      }
      const isQuiet = now - k.seenAt > KIT_QUIET_MS && (toolsRunning.get(k.id) ?? 0) === 0
      if (isQuiet) ended++
      return isQuiet ? finish(k, true, now) : k
    })
    const known = new Set(kept.map(k => k.id))
    const born = agents.filter(a => !known.has(a.id) && isListedStarting(a.status)).map(a => newKitten(a.id, now, true))
    return [...next, ...born]
  })
  if (ended > 0) await kittensFinished($, grown, now)
}

// Takes this session out of its room at once, instead of fading after 25 s.
const leave = async ($: EngineInterface, cfg: FriendsConfig) => {
  try {
    await $.http.fetch(`${cfg.server}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: cfg.room, id: await machineId($), session: sessionKey }),
    })
  } catch {
    // The server forgets a silent session on its own.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    const chosen = await chooseLang($)
    await update($, lang, () => chosen)
    tr = WORDS[chosen]
    await $.command.register({ name: 'cat', description: tr.commandHelp })
    try {
      await $.command.register({ name: 'кот', description: tr.commandHelp })
    } catch {
      // Not every build takes a non-Latin command name; /cat always works.
    }

    sessionKey = (await $.session.id()).slice(0, 12) || 'main'
    const saved = (await $.store.get(SETTINGS_KEY)) as { cacheMinutes?: number } | undefined
    await update($, cacheMinutes, () => (saved?.cacheMinutes === 5 ? 5 : 60))
    const cfg = await readConfig($)
    await update($, link, () => ({ room: joinedRoom(cfg), status: joinedRoom(cfg) ? 'ok' : 'off' }))
    // A room saved by a version that had a built-in server: say how to get back to it.
    if (cfg.room && !cfg.server) $.ui.toast(tr.backToRoom(cfg.room))

    const usage = await $.session.usage()
    await update($, limits, () => keepLimits(usage.rateLimits))
    await update($, context, () => keepContext(usage.context))
    await update($, costUsd, () => usage.cost?.usd ?? null)
    void readCompactWindow($)

    $.clock.every(TICK_MS, () => {
      void update($, frame, n => (n + 1) % FRAME_WRAP)
    })

    // The kittens follow this session's agents; after a reload, the poll squares them at once.
    void syncKittens($)
    $.clock.every(KIT_POLL_MS, () => {
      void syncKittens($)
    })

    // Heartbeat to the friends server, only when a server and a room are set.
    void beat($, await myStatus($), await read($, activity))
    $.clock.every(BEAT_MS, () => {
      void (async () => beat($, await myStatus($), await read($, activity)))()
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await useLang($)
    const cfg = await readConfig($)
    if (joinedRoom(cfg)) await leave($, cfg)
    return next(e)
  })

  on('command.run', { command: 'cat' }, ($, e) => runCommand($, e.args))
  on('command.run', { command: 'кот' }, ($, e) => runCommand($, e.args))

  on('session.measure', async ($, e, next) => {
    await useLang($)
    await update($, limits, () => keepLimits(e.rateLimits))
    await update($, context, () => keepContext(e.context))
    await update($, costUsd, () => e.cost?.usd ?? null)
    warnLimits($, e.rateLimits)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await useLang($)
    doneTimer?.cancel()
    cacheWarnTimer?.cancel()
    pendingLine?.cancel()
    const now = await $.clock.now()
    shownAt = now
    await update($, stats, () => ({ startedAt: now, tools: 0, errors: 0, seconds: 0 }))
    await update($, activity, () => tr.thinking)
    await update($, isWaiting, () => false)
    await update($, isSad, () => false)
    await update($, mood, () => 'busy')
    void beat($, 'busy', tr.thinking)
    void readCompactWindow($)
    return next(e)
  })

  // Fires exactly when the engine is about to show a permission dialog. An
  // agent's dialog is its kitten's: the cat asks along while that kitten does.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id === undefined) await update($, isWaiting, () => true)
    else await changeKitten($, e.agent_id, k => ({ ...k, isAsking: true }))
    void beat($, 'waiting', '')
    return next(e)
  })

  // An agent starting from the Agent tool: its kitten pops in at once.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) await bringKitten($, started.agentId)
    return started
  })

  // Every run of an agent loop starts with SubagentStart: the Agent tool's, a
  // workflow's (never listed), a resumed agent's. The engine's own helper
  // loops (memory, compaction) raise none and get no kitten.
  on('classic.SubagentStart', async ($, e, next) => {
    await bringKitten($, e.agent_id)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await useLang($)
    const asksUser = e.tool === 'AskUserQuestion'
    const agent = e.agentId
    if (agent !== undefined) {
      // An agent's tool is its kitten's business: this cat's turn, its line,
      // its counts and its waiting stay its own.
      const startedAt = await $.clock.now()
      await changeKitten($, agent, k => ({ ...k, seenAt: startedAt, isAsking: k.isAsking || asksUser }))
      toolsRunning.set(agent, (toolsRunning.get(agent) ?? 0) + 1)
      const ran = await next(e).finally(() => {
        const left = (toolsRunning.get(agent) ?? 1) - 1
        if (left > 0) toolsRunning.set(agent, left)
        else toolsRunning.delete(agent)
      })
      const now = await $.clock.now()
      const isFailed = ran.deny === undefined && ran.isError === true
      // A dialog belongs to a tool still running: with a sibling tool of the
      // agent's still going, its dialog may still be open.
      const isIdle = (toolsRunning.get(agent) ?? 0) === 0
      await changeKitten($, agent, k => ({
        ...k,
        isAsking: k.isAsking && !isIdle,
        seenAt: now,
        sadUntil: isFailed ? now + KIT_SAD_MS : k.sadUntil,
      }))
      return ran
    }
    await show($, describe(e))
    await update($, stats, s => ({ ...s, tools: s.tools + 1 }))
    if (asksUser) {
      await update($, isWaiting, () => true)
    }

    const ran = await next(e)

    await update($, isWaiting, () => false)
    if (ran.deny === undefined && ran.isError === true) {
      await update($, stats, s => ({ ...s, errors: s.errors + 1 }))
      await update($, isSad, () => true)
      sadTimer?.cancel()
      sadTimer = $.clock.after(2500, () => {
        void update($, isSad, () => false)
      })
    }
    await show($, tr.thinking)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await useLang($)
    const done = await next(e)
    // A subagent's run ends with its own turn.complete (it carries an agentId):
    // not a task of the person's, but its kitten's goodbye.
    if (e.agentId !== undefined) {
      await retireKitten($, e.agentId, e.reason === 'answer')
      return done
    }
    pendingLine?.cancel()

    // Only an answered turn closes a task: an interrupt, a refusal or an API
    // error counts nothing and is not celebrated.
    const isClosed = e.reason === 'answer'
    const now = await $.clock.now()
    await update($, stats, s => ({ ...s, seconds: Math.round((now - s.startedAt) / 1000) }))
    // The turn's last action is over: later beats must not keep sending it.
    await update($, activity, () => '')
    await update($, cacheAt, () => now)
    await update($, isSad, () => false)
    await update($, isWaiting, () => false)
    await update($, mood, () => (isClosed ? 'done' : 'idle'))

    const turn = await read($, stats)
    const { before, after } = await changeLifetime($, life => ({
      ...life,
      tasks: life.tasks + (isClosed ? 1 : 0),
      tools: life.tools + turn.tools,
      errors: life.errors + turn.errors,
      longestSeconds: isClosed ? Math.max(life.longestSeconds, turn.seconds) : life.longestSeconds,
    }))

    const ttlMs = (await read($, cacheMinutes)) * 60_000
    if (ttlMs > CACHE_WARN_MS * 2) {
      cacheWarnTimer = $.clock.after(ttlMs - CACHE_WARN_MS, () => {
        $.ui.toast(tr.cacheSoon)
      })
    }
    if (!isClosed) {
      void beat($, 'idle', '')
      return done
    }

    await bumpToday($)
    if (MILESTONES.includes(after.tasks)) {
      $.ui.toast(tr.milestone(after.tasks))
    } else if (before.longestSeconds > 0 && turn.seconds > before.longestSeconds) {
      $.ui.toast(tr.record(tr.duration(turn.seconds)))
    } else {
      $.ui.toast(tr.meowDone)
    }
    doneTimer = $.clock.after(DONE_MS, () => {
      void update($, mood, () => 'idle')
      void beat($, 'idle', '')
    })
    void beat($, 'done', '')
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await useLang($)
    const mode = await read($, view)
    if (e.props.hasSurvey || mode === 'hidden') {
      return next(e)
    }

    const turn = await read($, stats)
    const now = await $.clock.now()
    const current = settledMood(await read($, mood), turn, now)
    // The frame atom only ticks the redraw; the animation runs on the clock, so
    // a friend's cat steps alike on every screen and any stroll length wraps cleanly.
    await read($, frame)
    const n = Math.floor(now / TICK_MS)
    const cfg = await readConfig($)
    const myPal = paletteFor(cfg.color)
    // The kittens: the ones at work, and the ones still saying goodbye.
    const litter = await read($, kittens)
    const myKits = litter
      .filter(k => isAtWork(k) || now - k.endedAt < KIT_LEAVE_MS)
      .sort((a, b) => a.bornAt - b.bornAt)
      .slice(0, MAX_KITS_SHOWN)
    const kitsAtWork = litter.filter(isAtWork).length
    // The cat dozes off a while after its last turn or the last of its kittens.
    const restingSince = Math.max(turn.startedAt + turn.seconds * 1000, await read($, kittensDoneAt))
    const isPoked = (await read($, pokedUntil)) > now
    const isPettedMe = (await read($, pettedUntil)) > now
    const look: Look = {
      mood: current,
      isSad: current === 'busy' && (await read($, isSad)),
      isAsleep: current === 'idle' && kitsAtWork === 0 && now - restingSince > SLEEP_AFTER_MS && !isPettedMe && !isPoked,
      isWaiting: (current === 'busy' && (await read($, isWaiting))) || isKittenAsking(litter),
      isPetted: isPettedMe,
      isWatching: current === 'idle' && kitsAtWork > 0,
    }
    const words = caption(look, await read($, activity), turn, now, kitsAtWork)
    const readings = await read($, limits)
    const ttlMs = (await read($, cacheMinutes)) * 60_000
    const meters = [
      ...limitMeters(readings, now),
      contextMeter(await read($, context), await read($, compactWindow)),
      cacheMeter(await read($, cacheAt), current === 'busy', now, ttlMs),
      costMeter(await read($, costUsd), readings.length > 0),
    ].filter((m): m is Meter => m !== undefined)

    const crew = await read($, friends)
    const live = liveFriends(crew)
    const leaving = crew.filter(f => f.leftAt !== undefined)
    const petted = await read($, pettedFriends)
    const room = await read($, link)
    const mine = await read($, me)
    const isTerminal = e.surface === 'terminal'
    const hour = new Date(now).getHours()
    const palOf = (f: Friend) => paletteFor(f.color || colorFromId(f.id))

    // Everyone asleep for a while: the cats curl up together on this side.
    const isPile =
      look.isAsleep &&
      now - restingSince > PILE_AFTER_MS &&
      live.length > 0 &&
      live.every(f => f.status === 'idle' && f.kits === 0 && f.statusSeconds * 1000 > PILE_AFTER_MS)
    // Where a chase between this cat and friend f stands: its frame, or
    // undefined between chases and while either of them is not busy.
    const chaseFrame = (f: Friend) => {
      if (current !== 'busy' || f.status !== 'busy') return undefined
      const bothSince = Math.max(turn.startedAt, syncedAt - f.statusSeconds * 1000)
      const t = Math.floor(Math.max(0, now - bothSince) / TICK_MS) % CHASE_EVERY
      return t < CHASE_LEN ? t : undefined
    }
    const chaseWith = (f: Friend, pal: Palette): Scene['chase'] => {
      const t = chaseFrame(f)
      return t === undefined ? undefined : { pal, t }
    }
    const chasing = live.find(f => chaseFrame(f) !== undefined)
    const myScene: Scene = {
      isPoked,
      chase: chasing && chaseWith(chasing, palOf(chasing)),
      pile: isPile ? live.slice(0, 2).map(palOf) : undefined,
    }
    const isPettedFriend = (f: Friend) => (petted[f.id] ?? 0) > now
    const friendStatus = (f: Friend) =>
      f.leftAt !== undefined
        ? { text: tr.wentHome, color: GRAY }
        : isPettedFriend(f)
          ? { text: tr.purr, color: '#e0457b' }
          : { text: `${friendWord(f)}${f.doing ? ` · ${f.doing}` : ''}${friendKitsNote(f)}`, color: FRIEND_STATUS_COLOR[f.status] }
    const furOf = (f: Friend) => hex((FUR[f.color || colorFromId(f.id)] ?? ORANGE_FUR)[0])

    // This cat's caption: its mood emoji, a meow, and a note someone left.
    const mainLine = `${cfg.mood ? `${cfg.mood} ` : ''}${isPoked ? tr.poked : words.main}`
    const secondLine = mine?.bubble ? `💬 ${mine.bubble.from}: ${mine.bubble.text}` : words.facts || ' '

    // What the caption says about the room itself, where the cats do not show it.
    const roomNote =
      room.status === 'down'
        ? { text: tr.noLink, color: RED }
        : isPile
          ? { text: tr.pile, color: GRAY }
          : room.room !== '' && live.length === 0
            ? { text: tr.waitingFriends, color: GRAY }
            : undefined
    const crewLine =
      room.status === 'down'
        ? ` · 👥 ${tr.noLinkShort}`
        : live.length > 0
          ? ` · 👥 ${live.map(f => `${f.name}${f.mood ? ` ${f.mood}` : ''} ${friendWord(f)}${f.limit5 === null ? '' : ` ${Math.round(f.limit5)}%`}${friendKitsNote(f)}`).join(', ')}`
          : ''
    const compactLine = meters.map(shortMeter).join(' · ')
    // The one-line band: an idle cat's line already counts its kittens.
    const kitNote = kitsAtWork > 0 && current !== 'idle' ? ` · ${tr.kittens(kitsAtWork)}` : ''
    const shown = [...live.slice(0, MAX_FRIENDS_SHOWN), ...leaving]
    const more = live.length - Math.min(live.length, MAX_FRIENDS_SHOWN)
    const myKitViews = myKits.map(
      (k): KitView => ({
        seed: seedOf(k.id),
        age: Math.max(0, Math.floor((now - k.bornAt) / TICK_MS)),
        status: k.status,
        isAsking: k.isAsking,
        isSad: k.sadUntil > now,
        gone: isAtWork(k) ? -1 : Math.floor((now - k.endedAt) / TICK_MS),
      }),
    )
    // A friend's kittens are only a count: they play, and come and go without a word.
    const friendKits = (f: Friend) =>
      f.leftAt !== undefined
        ? []
        : Array.from(
            { length: Math.min(MAX_KITS_SHOWN, f.kits) },
            (_, j): KitView => ({ seed: seedOf(`${f.id}:${j}`), age: KIT_GROWN, status: 'running', isAsking: false, isSad: false, gone: -1 }),
          )

    // The yard, `width` pixels wide, this cat in front. Each cat keeps to a lane
    // of its own while it strolls, sleeps or waits, this cat the leftmost, so the
    // cats do not stand on each other; running and chasing take the whole yard.
    // A friend chasing this cat runs in this cat's scene, and in a pile the
    // friends lie with it.
    // A cat's kittens play in its lane. The lanes do not depend on how many
    // kittens there are, so agents coming and going move no cat.
    const yardOf = (width: number) => {
      const lane = width / (shown.length + 1)
      const laneOf = (i: number) => {
        const start = Math.round(i * lane)
        const end = Math.round(start + lane)
        // In a yard too narrow for every cat, the last one still keeps inside it.
        const home = Math.min(start + 2, width - SPRITE_W)
        const walk: [number, number] = [home, Math.max(home, end - SPRITE_W - 6)]
        return { home, walk, lane: [start, end] as [number, number] }
      }
      const cats = shown.flatMap((f, i): YardCat[] => {
        if (isPile) return []
        const { home, walk, lane } = laneOf(i + 1)
        return [
          {
            look: friendLook(f, isPettedFriend(f)),
            pal: palOf(f),
            scene: {
              pose:
                f.leftAt === undefined
                  ? undefined
                  : { x: home + 3 * Math.floor((now - f.leftAt) / TICK_MS), gait: 'walk', isLeft: false },
            },
            n: n + phaseOf(f.id),
            home,
            walk,
            kits: friendKits(f),
            lane,
            isAway: f === chasing,
          },
        ]
      })
      cats.push({ look, pal: myPal, scene: myScene, n, kits: myKitViews, ...laneOf(0) })
      return yard(width, hour, n, cats)
    }

    // Fit the band to its width. The meters keep to the right edge, and the
    // yard on the left takes the room the caption and the meters leave, from one
    // cat's up to a few cats'. The cats come first: the meters drop their bars
    // (the numbers stay) before the yard shrinks below its full size, and get
    // their notes only after that. Narrower than one cat's room, the band is
    // one line. Kittens come and go with the agents, so they take no room of
    // their own: they play in their cats' lanes and move nothing on the band.
    const width = e.props.bodyColumns
    const yardMin = isTerminal ? COLS : DESKTOP_CAT_W
    const yardMax =
      yardMin + Math.min(live.length, MAX_FRIENDS_SHOWN) * YARD_PER_FRIEND[isTerminal ? 'terminal' : 'desktop']
    const barW = isTerminal ? 10 : DESKTOP_BAR_W
    const metersW = (bars: boolean, notes: boolean) =>
      meters.length > 0 ? 2 + NAME_W + (bars ? barW : 0) + VALUE_W + (notes ? NOTE_W : 0) : 0
    const besideYard = (bars: boolean, notes: boolean) => 1 + CAPTION_W + metersW(bars, notes)
    const isTooNarrow = yardMin + besideYard(false, false) > width
    const showBars = yardMax + besideYard(true, false) <= width
    const yardW = Math.max(yardMin, Math.min(yardMax, width - besideYard(showBars, false)))
    const showNotes = showBars && yardW + besideYard(true, true) <= width

    if (isTerminal) {
      const { Box, Button, Raster, Text } = $.ui.resolve(e)
      if (mode === 'compact' || isTooNarrow) {
        return (
          <Box flexDirection="row">
            <Text color="magenta">{look.isWaiting ? '=^o^=' : '=^.^='} {mainLine}{kitNote}</Text>
            <Text dimColor wrap="truncate-end"> · {compactLine}{crewLine}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="row" alignItems="center">
          <Raster key="cat" columns={yardW} rows={RASTER_ROWS} cells={raster(yardOf(yardW))} />
          <Box flexDirection="column" paddingLeft={1} width={CAPTION_W}>
            <Text color="magenta" wrap="truncate-end">{mainLine}</Text>
            <Text dimColor={!mine?.bubble} wrap="truncate-end">{secondLine}</Text>
            <Button key="pet" label={tr.pet} plain dimColor onPress={() => pet($)} />
            {shown.map(f => (
              <Box key={f.id} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={furOf(f)}>{FRIEND_FACE[f.status]} </Text>
                  <Text wrap="truncate-end">
                    {f.name}{f.mood ? ` ${f.mood}` : ''}{' '}
                  </Text>
                  {f.limit5 !== null && f.leftAt === undefined && (
                    <Text color={usedColor(f.limit5)}>{textBar(f.limit5, 5)} {Math.round(f.limit5)}% </Text>
                  )}
                  <Text color={friendStatus(f).color} wrap="truncate-end">{friendStatus(f).text}</Text>
                </Box>
                {f.bubble && <Text wrap="truncate-end">  💬 {f.bubble.from}: {f.bubble.text}</Text>}
              </Box>
            ))}
            {more > 0 && <Text dimColor>{tr.more(more)}</Text>}
            {roomNote && <Text color={roomNote.color} wrap="truncate-end">👥 {roomNote.text}</Text>}
          </Box>
          <Box key="meters" flexGrow={1} flexDirection="row" justifyContent="flex-end">
            <Box flexDirection="column" paddingLeft={2}>
              {meters.map(m => (
                <Box key={m.kind} flexDirection="row">
                  <Box width={NAME_W}>
                    <Text dimColor>{m.name}</Text>
                  </Box>
                  {showBars && <Text color={m.color}>{m.fill === null ? ' '.repeat(10) : textBar(m.fill)}</Text>}
                  <Box width={VALUE_W} justifyContent="flex-end">
                    <Text color={m.color} bold>{m.value}</Text>
                  </Box>
                  {showNotes && <Text dimColor wrap="truncate-end">  {m.note}</Text>}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }

    // Drawn as a plain image (no sandboxed frame), so it sits on the app's own background.
    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    const yardAlt = tr.yardAlt(live.length > 0)
    if (mode === 'compact' || isTooNarrow) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={svgPicture(yardOf(COLS), 1)} alt={yardAlt} width={COLS} height={HEIGHT} />
          <Text>{mainLine}{kitNote}</Text>
          <Text dimColor wrap="truncate-end">· {compactLine}{crewLine}</Text>
        </Box>
      )
    }
    const yardPx = yardW * DESKTOP_YARD_PX
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box width={yardW}>
          <Svg source={svgPicture(yardOf(yardPx), 2)} alt={yardAlt} width={yardPx * 2} height={HEIGHT * 2} />
        </Box>
        <Box flexDirection="column" width={CAPTION_W}>
          <Text wrap="truncate-end">{mainLine}</Text>
          <Text dimColor={!mine?.bubble} wrap="truncate-end">{secondLine}</Text>
          <Button key="pet" label={tr.pet} plain dimColor onPress={() => pet($)} />
          {shown.map(f => (
            <Box key={f.id} flexDirection="column">
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text color={furOf(f)} wrap="truncate-end">{f.name}{f.mood ? ` ${f.mood}` : ''}</Text>
                <Text color={friendStatus(f).color} wrap="truncate-end">{friendStatus(f).text}</Text>
                {f.limit5 !== null && f.leftAt === undefined && (
                  <Box flexDirection="row" alignItems="center" columnGap={1}>
                    {showNotes && <Text dimColor>{tr.limits.five_hour}</Text>}
                    <Box width={DESKTOP_FRIEND_BAR_CELLS}>
                      <Svg
                        source={svgBar(f.limit5, usedColor(f.limit5), FRIEND_BAR_W)}
                        alt={`${tr.limits.five_hour}: ${Math.round(f.limit5)}%`}
                        width={FRIEND_BAR_W}
                        height={BAR_H}
                      />
                    </Box>
                    <Text color={usedColor(f.limit5)}>{Math.round(f.limit5)}%</Text>
                  </Box>
                )}
                {f.leftAt === undefined && (
                  <Button key={`pet-${f.id}`} label="♥" plain dimColor onPress={() => petFriend($, f.id)} />
                )}
                {f.leftAt === undefined && (
                  <Button key={`meow-${f.id}`} label={tr.meow} plain dimColor onPress={() => meowFriend($, f.id, f.name)} />
                )}
                {f.leftAt === undefined &&
                  f.status === 'done' &&
                  REACTIONS.map(emoji => (
                    <Button key={`react-${emoji}-${f.id}`} label={emoji} plain onPress={() => reactTo($, f.id, f.name, emoji)} />
                  ))}
              </Box>
              {f.bubble && <Text wrap="truncate-end">💬 {f.bubble.from}: {f.bubble.text}</Text>}
            </Box>
          ))}
          {more > 0 && <Text dimColor>{tr.more(more)}</Text>}
          {roomNote && <Text color={roomNote.color} wrap="truncate-end">👥 {roomNote.text}</Text>}
        </Box>
        {meters.length > 0 && (
          // The meters keep to the band's right edge, leaving the room on the left to the cats.
          <Box key="meters" flexGrow={1} flexDirection="row" justifyContent="flex-end">
            <Box flexDirection="column" paddingLeft={1}>
              {meters.map(m => (
                <Box key={m.kind} flexDirection="row" alignItems="center">
                  <Box width={NAME_W}>
                    <Text dimColor>{m.name}</Text>
                  </Box>
                  {showBars && (
                    <Box width={DESKTOP_BAR_W}>
                      <Svg
                        source={m.fill === null ? EMPTY_BAR : svgBar(m.fill, m.color)}
                        alt={m.fill === null ? ' ' : `${Math.round(m.fill)}%`}
                        width={BAR_W}
                        height={BAR_H}
                      />
                    </Box>
                  )}
                  <Box width={VALUE_W} justifyContent="flex-end">
                    <Text color={m.color} bold>{m.value}</Text>
                  </Box>
                  {showNotes && (
                    <Box paddingLeft={1}>
                      <Text dimColor wrap="truncate-end">{m.note}</Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
