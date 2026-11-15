import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Fold, Purge, TempScan, Window } from '../types'
import {
  BG, EMPTY, HUE, MUTED, ORANGE, TEXT, TTL_MIN, TTL_MS, YELLOW,
  bandPx, cardSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, usd,
} from './cache-art'
import type { CacheView } from './cache-art'
import { keepWarm, readWarm, warmWord } from './warm'
import {
  LIST_MAX, PURGE_WINDOW_MS, askPurge, baseName, cancelPurge, deleteAll, deleteOne, fmtBytes, folderOf,
  isTempPath, scanTemp, sessionTempDir, track,
} from './temp'

// A band above the prompt in a warm dark look: card surface, cream text. Starts
// with the session's live cost (green under $3, yellow to $6, red and blinking
// past $6), then how much of each usage window is LEFT, 7-day first, then
// 5-hour; 7D is orange, 5H is yellow; a window under 15% adds a bold LOW.
//
// After the first reply it also shows the prompt cache: WARM (red)
// for an hour after the last request, then COLD (blue) with what the
// next message costs to re-cache. Hide / Show folds the card; warm starts folded,
// cold starts open, and a choice holds until the cache flips. Zero token cost:
// it reads the engine's own figures and draws.

const LOW_AT = 15
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000

const windows = atom({ plugin: 'ribbon', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'ribbon', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'ribbon', key: 'fold' } as const, null as Fold | null)
const temp = atom({ plugin: 'ribbon', key: 'temp' } as const, null as TempScan | null)
const purge = atom({ plugin: 'ribbon', key: 'purge' } as const, null as Purge | null)

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }
const COLORS: Record<string, string> = { seven_day: ORANGE, five_hour: YELLOW }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

/** Session cost thresholds (USD) and colors: green below $3, yellow below $6, red from $6. */
const COST_YELLOW_AT = 3
const COST_RED_AT = 6
const GREEN = '#6cc070'
const RED = '#e5534b'
const RED_DIM = '#5a2a27'
/** Blink half-period for a cost over $6. */
const BLINK_MS = 700
/** Set by the band while the cost blinks, so the fast timer redraws only then. */
let blinking = false

/** The keep-warm button's icon for each cache state. */
const ICON = { warm: '🔥', cold: '❄️' } as const
/** Context use (percent) from which ✋ is drawn as the one to press. */
const HANDOFF_URGE_AT = 75

/**
 * ✋: runs the handoff mod's /handoff, as if typed. That mod writes the handoff
 * and draws its own steps and progress above the prompt; a missing or switched
 * off handoff mod is said in a toast.
 */
async function startHandoff($: EngineInterface): Promise<void> {
  try {
    const r = await $.command.run({ command: 'handoff' })
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    if (text && !text.startsWith('Writing the handoff')) $.ui.toast(text)
  } catch (err) {
    $.ui.toast(`Handoff unavailable: ${err instanceof Error ? err.message : String(err)}. Is the handoff mod on?`)
  }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine: familyOf(c.model),
  }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures from the engine onto the cache facts, when it has them. */
const measure = async ($: EngineInterface, lastAt: number | null, model: string | null): Promise<void> => {
  const u = await $.session.usage()
  const m = model ?? (await $.session.model())
  await update($, cache, c => ({
    lastAt: lastAt ?? c?.lastAt ?? 0,
    tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0),
    window: u.context.window || c?.window || 0,
    model: m || c?.model || null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    // A fast redraw only while the cost blinks (over $6); otherwise it does nothing.
    $.clock.every(BLINK_MS, () => {
      if (blinking) $.ui.invalidate('ui.render')
    })
    await scanTemp($).catch(err => $.ui.log(`ribbon: temp scan failed: ${err instanceof Error ? err.message : String(err)}`))
    return next(e)
  })

  // A new file the Write tool puts in a temp folder joins the band's temp list.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const path = e.file_path
    if (!isTempPath(path)) return next(e)
    const isNew = !(await $.fs.exists(path).catch(() => true))
    const ran = await next(e)
    if (isNew && ran.deny === undefined && ran.isError !== true) {
      await track($, path).catch(() => undefined)
      void scanTemp($).catch(() => undefined)
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens, window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0, window: c?.window ?? 0, model: c?.model ?? null }))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
    await measure($, lastAt, e.usage?.model ?? null)
    await scanTemp($).catch(() => undefined)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal gets the text form.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, windows)
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    if (list.length === 0 && !view) {
      return (
        <Box backgroundColor={BG} paddingX={1}>
          <Text color={MUTED}>waiting for the first reply</Text>
        </Box>
      )
    }

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const kind = kindOf(columns)
    const isWide = kind === 'wide'
    const parts = (w: Window) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        left,
        col: COLORS[w.kind] ?? TEXT,
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        reset: fmtReset(w.resetsAt, now),
      }
    }

    // Wide: every window on one row. Narrow: each window is a block of three
    // lines (name, percent left, reset time) so nothing wraps or clips.
    const wide = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} marginRight={3}>
          <Text color={MUTED} bold>{p.name}</Text>
          <Text color={p.col} bold> {p.left}% left</Text>
          {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          {p.reset ? <Text color={MUTED}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const stacked = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="column" flexShrink={0} marginRight={3}>
          <Text color={MUTED} bold>{p.name}</Text>
          <Box flexDirection="row">
            <Text color={p.col} bold>{p.left}% left</Text>
            {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          </Box>
          {p.reset ? <Text color={MUTED}>resets {p.reset}</Text> : null}
        </Box>
      )
    }

    // The session's live cost, first on the left: green under $3, yellow to $6,
    // red from $6, and blinking once it is over $6.
    const spent = (await $.session.usage()).cost?.usd ?? 0
    blinking = spent > COST_RED_AT
    const blinkOn = !blinking || Math.floor(now / BLINK_MS) % 2 === 0
    const costCol = spent < COST_YELLOW_AT ? GREEN : spent < COST_RED_AT ? YELLOW : blinkOn ? RED : RED_DIM
    const costEl = (
      <Box key="cost" flexShrink={0} marginRight={3} alignItems="flex-start">
        <Text color={costCol} bold tabular>{usd(spent)}</Text>
      </Box>
    )

    const usage = [
      costEl,
      ...(list.length > 0
        ? list.map(isWide ? wide : stacked)
        : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]),
    ]

    // ✋ hands off through the handoff mod: it runs that mod's /handoff, whose own
    // panel above the prompt shows the steps and progress. Marked as the one to
    // press once the context is filling up.
    const ctxPct = view && view.window > 0 ? Math.round((view.tokens / view.window) * 100) : 0
    const handoffBtn = (k = '') => (
      <Box key={`handoff-box${k}`} flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button
          key={`handoff${k}`}
          label="✋"
          variant={ctxPct >= HANDOFF_URGE_AT ? 'primary' : 'secondary'}
          onPress={() => void startHandoff($)}
        />
      </Box>
    )

    // The temp-file warning, on its own second line: how many files this session
    // left on disk, and their size.
    const scan = await read($, temp)
    const tempCount = scan?.files.length ?? 0
    const tempLine = (shown: boolean) => tempCount > 0 && shown ? (
      <Box key="temp-chip" flexDirection="row" paddingX={1} alignItems="center">
        <Text color={YELLOW} bold>⚠ {tempCount}</Text>
        <Text color={MUTED}>{` temp file${tempCount === 1 ? '' : 's'} · `}</Text>
        <Text color={YELLOW} bold>{fmtBytes(scan?.total ?? 0)}</Text>
      </Box>
    ) : null

    // Before the first reply there is no cache to show: today's band, as it was.
    if (!view) {
      return (
        <Box flexDirection="column" backgroundColor={BG}>
          <Box key="row" flexDirection="row" paddingX={1}>
            {usage}
            <Box key="grow" flexGrow={1} />
            {handoffBtn()}
          </Box>
          {tempLine(true)}
        </Box>
      )
    }
    const mode = view.mode
    const cold = mode === 'cold'
    const hue = HUE[mode]
    const mine = mineModel(view)
    const stored = await read($, fold)
    // Folding needs the card, and the card is a drawing: the terminal stays folded.
    const open = Svg !== null && (stored && stored.mode === mode ? stored.open : cold)
    const toggle = () =>
      update($, fold, f => ({ mode, open: !(f && f.mode === mode ? f.open : mode === 'cold') }))

    // The chip is the keep-warm button: a press reads the cache so its hour restarts.
    const wa = await readWarm($)
    const word = warmWord(wa, ICON[mode], now)
    const badge = (k = '') => (
      <Box key={`warm-box${k}`} flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button
          key={`keep-warm${k}`}
          label={word}
          variant="secondary"
          onPress={() => {
            if (wa?.status !== 'busy') void keepWarm($, cold)
          }}
        />
      </Box>
    )

    const summary = cold
      ? [
          <Text key="idle" color={hue} bold>{` ${view.idle}`}</Text>,
          mine ? <Text key="dot" color={MUTED}> · </Text> : null,
          mine ? <Text key="cost" color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text> : null,
        ]
      : [<Text key="left" color={hue} bold>{` ${Math.max(0, TTL_MIN - view.idleMin)}m left`}</Text>]

    const button = (k = '') => Svg ? (
      <Box key={`fold${k}`} flexShrink={0} alignItems="flex-start" marginLeft={1}>
        <Button key={`cache-fold${k}`} label={open ? '▼' : '▲'} onPress={toggle} />
      </Box>
    ) : null
    const grow = <Box key="grow" flexGrow={1} />

    // Every button sits on the right, after the cache's time: "57m left 🔥 ✋ ▼".
    const controls = (k: string) => [badge(k), handoffBtn(k), button(k)]

    // The first row, built by key suffix: '' in the flow, ':pin' for the pinned copy.
    const rowsOf = (k: string) => {
    let rows
    if (kind === 'wide') {
      rows = (
        <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
          {usage}
          {grow}
          {open ? null : (
            <Box key="inline" flexDirection="row" flexShrink={0} alignItems="center">
              {summary}
            </Box>
          )}
          {controls(k)}
        </Box>
      )
    } else if (kind === 'stacked') {
      // The cache's time becomes a stacked block, the same shape as 7D and 5H.
      rows = (
        <Box key="row" flexDirection="row" paddingX={1}>
          {usage}
          {grow}
          {open ? null : (
            <Box key="block" flexDirection="column" flexShrink={0} alignItems="flex-end">
              <Text color={hue} bold>{cold ? `${view.idle} idle` : `${Math.max(0, TTL_MIN - view.idleMin)}m left`}</Text>
              {mine ? (
                <Box flexDirection="row">
                  <Text color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text>
                  <Text color={MUTED}> next</Text>
                </Box>
              ) : null}
            </Box>
          )}
          {controls(k)}
        </Box>
      )
    } else {
      // Narrow: the cache gets its own row under the usage blocks.
      rows = [
        <Box key="row" flexDirection="row" paddingX={1}>
          {usage}
        </Box>,
        <Box key="cache" flexDirection="row" paddingX={1} alignItems="center">
          {grow}
          {summary}
          {controls(k)}
        </Box>,
      ]
    }

    return rows
    }
    const rows = rowsOf('')

    // Open and scrolled: a copy of the first row stays pinned at the top of the
    // band's window (the scroll offset, in rows), over what scrolls beneath it.
    const offset = e.props.scroll?.offset ?? 0
    const pinned = open && offset > 0 ? (
      <Box key="pinned" position="absolute" top={offset} left={0} right={0} flexDirection="column" backgroundColor={BG}>
        {rowsOf(':pin')}
      </Box>
    ) : null

    let card = null
    if (open && Svg) {
      const c = cardSvg(view, kind, bandPx(columns))
      card = (
        <Box key="card" flexDirection="row">
          <Svg source={c.source} alt={c.alt} width={c.w} height={c.h} isInteractive={kind !== 'tight'} />
        </Box>
      )
    }

    // Open: under the card, every temp file with its own delete button, then
    // Delete all, which asks once before it clears them.
    let tempList = null
    if (open && scan && tempCount > 0) {
      const p = await read($, purge)
      const confirming = p !== null && now - p.at < PURGE_WINDOW_MS
      const home = await $.env.get('HOME').catch(() => undefined)
      const dir = sessionTempDir()
      const shown = scan.files.slice(0, LIST_MAX)
      const rest = scan.files.slice(LIST_MAX)
      const restBytes = rest.reduce((n, f) => n + f.size, 0)
      const sizeCol = 9

      const header = confirming ? (
        <Box key="temp-head" flexDirection="row" alignItems="center" paddingX={1} marginTop={1}>
          <Text color={TEXT} bold>{`Delete all ${tempCount} file${tempCount === 1 ? '' : 's'} (${fmtBytes(scan.total)})?`}</Text>
          <Text color={MUTED}> This can't be undone.</Text>
          <Box flexGrow={1} />
          <Box flexShrink={0} marginRight={2}>
            <Button key="temp-cancel" label="Cancel" variant="secondary" onPress={() => void cancelPurge($)} />
          </Box>
          <Box flexShrink={0}>
            <Button key="temp-confirm" label="Delete all" variant="primary" onPress={() => void deleteAll($)} />
          </Box>
        </Box>
      ) : (
        <Box key="temp-head" flexDirection="row" alignItems="center" paddingX={1} marginTop={1}>
          <Text color={MUTED} bold>TEMP FILES</Text>
          <Text color={MUTED}>{'  ·  this session  ·  '}</Text>
          <Text color={YELLOW} bold>{`${tempCount} file${tempCount === 1 ? '' : 's'} · ${fmtBytes(scan.total)}`}</Text>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Button key="temp-delete-all" label="Delete all" variant="secondary" onPress={() => void askPurge($)} />
          </Box>
        </Box>
      )

      const fileRow = (f: { path: string; size: number }, i: number) => (
        <Box key={`temp-${i}`} flexDirection="row" alignItems="center" paddingX={1}>
          <Text color={EMPTY} tabular>{String(i + 1).padStart(2, ' ')}  </Text>
          <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={TEXT} wrap="truncate-middle">{baseName(f.path)}</Text>
            <Text color={MUTED} wrap="truncate-start">{`  ${folderOf(f.path, dir, home ?? null)}`}</Text>
          </Box>
          <Box width={sizeCol} flexShrink={0} justifyContent="flex-end">
            <Text color={MUTED} tabular>{fmtBytes(f.size)}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Button key={`temp-del:${f.path}`} label="🗑" plain dimColor onPress={() => void deleteOne($, f.path)} />
          </Box>
        </Box>
      )

      tempList = (
        <Box key="temp" flexDirection="column" rowGap={1} paddingBottom={1}>
          {header}
          {shown.map(fileRow)}
          {rest.length > 0 ? (
            <Box key="temp-more" flexDirection="row" paddingX={1}>
              <Text color={MUTED}>{`    + ${rest.length} more (${fmtBytes(restBytes)}), included in Delete all`}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" backgroundColor={BG}>
        {rows}
        {tempLine(!open)}
        {card}
        {tempList}
        {pinned}
      </Box>
    )
  })
}
