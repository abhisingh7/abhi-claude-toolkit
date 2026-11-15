import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { CacheFacts, Warm } from '../types'

// The WARM / COLD chip as a button: one press sends a tiny side request over the
// whole conversation, as the main thread last sent it. The API serves that prefix
// from the prompt cache, and a cache read restarts the entry's hour, so the
// session stays warm. On a cold cache the same press writes the cache afresh,
// which costs what the band shows as the next message's price.
//
// Same behaviour as the Handoff button: a toast when it starts and when it ends,
// a busy label while it runs, a ✓ or ✕ for two minutes after, presses ignored
// while one is running.

export const warm = atom({ plugin: 'ribbon', key: 'warm' } as const, null as Warm | null)
const cacheAtom = atom({ plugin: 'ribbon', key: 'cache' } as const, null as CacheFacts | null)

const PING = 'Keep-alive ping from a status bar button. You have no tools and must not think it over: reply with exactly the word OK and nothing else.'

/** How long the ✓ or ✕ stays on the chip. */
const SHOW_RESULT_MS = 120_000

let running = false

const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

export type WarmOutcome = { ok: true; cachedTokens: number } | { ok: false; reason: string }

export async function keepWarm($: EngineInterface, wasCold: boolean): Promise<WarmOutcome> {
  if (running) return { ok: false, reason: 'already warming' }
  running = true
  try {
    const startedAt = await $.clock.now()
    await update($, warm, (): Warm => ({ status: 'busy', at: startedAt, reason: null }))
    $.ui.toast(wasCold ? 'Re-warming the cache: this costs about one cold message.' : 'Keeping the cache warm…')

    const r = await $.model.fork({ prompt: PING })
    const now = await $.clock.now()
    if (!r.isAnswered) {
      const reason =
        r.reason === 'nothing-to-fork' ? 'nothing to keep warm yet: send a message first' : `no reply (${r.reason})`
      await update($, warm, (): Warm => ({ status: 'error', at: now, reason }))
      $.ui.toast(`Keep warm failed: ${reason}`)
      return { ok: false, reason }
    }

    const cachedTokens = r.usage.cache_read_input_tokens ?? 0
    // The request just read (or rewrote) the cache: the hour starts again now.
    await update($, cacheAtom, c => (c ? { ...c, lastAt: now } : c))
    await update($, warm, (): Warm => ({ status: 'done', at: now, reason: null }))
    $.ui.toast(
      cachedTokens > 0
        ? `Cache kept warm for another 60 min (${kTokens(cachedTokens)} tokens read from cache).`
        : 'Cache re-written: warm for the next 60 min.',
    )
    return { ok: true, cachedTokens }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, warm, (): Warm => ({ status: 'error', at: Date.now(), reason }))
    $.ui.toast(`Keep warm failed: ${reason}`)
    return { ok: false, reason }
  } finally {
    running = false
  }
}

/** The chip's word for the state it is in: WARM / COLD, WARMING…, or a ✓ / ✕ after a press. */
export function warmWord(w: Warm | null, base: string, now: number): string {
  if (w?.status === 'busy') return `${base}…`
  if (!w || now - w.at > SHOW_RESULT_MS) return base
  return w.status === 'done' ? `${base} ✓` : `${base} ✕`
}

export function readWarm($: EngineInterface): Promise<Warm | null> {
  return read($, warm)
}
