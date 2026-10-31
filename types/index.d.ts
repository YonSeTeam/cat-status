export type Mood = 'idle' | 'busy' | 'done'

export type View = 'full' | 'compact' | 'hidden'

// The language the cat speaks in.
export type Lang = 'ru' | 'en'

export type TurnStats = {
  startedAt: number
  tools: number
  errors: number
  seconds: number
}

export type LimitReading = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type ContextReading = {
  percent?: number
  tokens?: number
  window: number
}

export type FriendStatus = 'idle' | 'busy' | 'waiting' | 'done'

export type Friend = {
  id: string
  self: boolean
  name: string
  color: string
  status: FriendStatus
  doing: string
  sessions: number
  secondsAgo: number
  // How long the friend has had this status, as of the last beat.
  statusSeconds: number
  // An emoji the friend set with /cat mood ('' for none).
  mood: string
  // Tasks the friend closed today.
  today: number
  // The friend's agents at work right now (up to 20): their cat has as many kittens.
  kits: number
  // How much of the friend's 5-hour limit is used, if they are on a subscription.
  limit5: number | null
  // A note someone left over this cat, shown for a minute.
  bubble: { from: string; text: string } | null
  // When the friend left the room: their cat walks off before it disappears.
  leftAt?: number
}

// The link to the friends server: no room, connected, or unreachable.
export type Link = { room: string; status: 'off' | 'ok' | 'down' }

// One of this session's agents, drawn as a kitten beside the cat.
export type Kitten = {
  // The agent's id, as its tool calls, its turn.complete and $.agent.list name it.
  id: string
  // When the kitten came, or came back for a resumed agent: it pops in and its games run from here.
  bornAt: number
  // 'done' and 'failed' are a finished agent, there for a moment as it leaves.
  status: 'running' | 'done' | 'failed'
  // While its agent waits on the person: a permission dialog, or a question.
  isAsking: boolean
  // When the agent finished (0 while it works). A finished kitten stays in the
  // list after it is drawn no more, so a poll does not bring it back while its
  // agent winds down.
  endedAt: number
  // Until when it cries after a tool of its failed.
  sadUntil: number
  // The last time its agent did anything.
  seenAt: number
  // Whether $.agent.list has listed it. A listed kitten leaves when the list
  // stops showing it at work; a workflow's agents are never listed.
  isListed: boolean
  // For a finished listed kitten: the list has since shown its agent not at
  // work, so seeing it at work again means the agent took up new work.
  hasRested: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cat-status': {
      mood: Mood
      frame: number
      activity: string
      isSad: boolean
      stats: TurnStats
      limits: LimitReading[]
      cacheAt: number
      context: ContextReading | null
      // The window auto-compaction runs against, when it is on; it can be
      // smaller than the model's window, and the context meter fills against it.
      compactWindow: number | null
      costUsd: number | null
      isWaiting: boolean
      pettedUntil: number
      view: View
      friends: Friend[]
      link: Link
      cacheMinutes: number
      pettedFriends: Record<string, number>
      // Until when this cat shows '!' after a friend meowed.
      pokedUntil: number
      // This cat's own entry from the room: its bubble and so on.
      me: Friend | null
      kittens: Kitten[]
      // When the last kitten finished: the cat dozes off a while after that.
      kittensDoneAt: number
      lang: Lang
    }
  }
}
