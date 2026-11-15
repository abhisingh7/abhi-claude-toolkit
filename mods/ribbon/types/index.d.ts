/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request (clock milliseconds), how much context the next request re-sends,
 * the model's context window, and the model.
 */
export type CacheFacts = { lastAt: number; tokens: number; window: number; model: string | null }

/** Whether the cache card is open, remembered only for the state it was set in. */
export type Fold = { mode: 'warm' | 'cold'; open: boolean }


/** The keep-warm chip's last press: running, done or failed (why). */
export type Warm = { status: 'busy' | 'done' | 'error'; at: number; reason: string | null }

/** One temp file this session made: its absolute path, size in bytes, last change (clock ms). */
export type TempFile = { path: string; size: number; mtimeMs: number }

/** The last scan of this session's temp files, largest first, with their total size. */
export type TempScan = { files: TempFile[]; total: number; at: number }

/** Delete all's confirm step: asked at `at`, until it is answered or runs out. */
export type Purge = { at: number }

declare module 'claude-code' {
  interface PluginState {
    'ribbon': {
      windows: Window[]
      cache: CacheFacts | null
      fold: Fold | null
      warm: Warm | null
      temp: TempScan | null
      tracked: string[]
      purge: Purge | null
    }
  }
}
