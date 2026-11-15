import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const SID = 'sess-1234'
const DIR = `/private/tmp/claude-501/-work/${SID}`
const WINDOWS = [{ kind: 'seven_day', percentUsed: 45 }]
const PROPS = {
  hasSurvey: false, isCollapsed: false, isWorking: false,
  maxRows: 30, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const file = (name: string, size: number) => ({ name, kind: 'file' as const, size, mtimeMs: NOW, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false })

/** A fake disk: the session's temp folder with two files, and rm that empties it. */
function disk(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const removed: string[] = []
  const tree: Record<string, ReturnType<typeof file | typeof dir>[]> = {
    '/private/tmp': [dir('claude-501'), dir('other')],
    '/private/tmp/claude-501': [dir('-work')],
    [DIR]: [dir('images'), dir('scratchpad')],
    [`${DIR}/images`]: [file('1.png', 90_000)],
    [`${DIR}/scratchpad`]: [file('notes.txt', 2_048)],
  }
  on('session.id', () => ({ value: SID }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.exists', ($, e) => ({ value: e.path === DIR }))
  on('fs.list', ($, e) => ({
    value: (tree[e.path] ?? []).filter(x => !removed.includes(`${e.path}/${x.name}`)),
  }))
  on('process.run', ($, e) => {
    removed.push(...e.argv.slice(3))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return removed
}

async function start($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  // A cold cache: the card (and the temp list under it) starts open.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 50000, model: 'claude-opus-5-5' })
}

test('the band warns with the count and size, and the open card lists each file with a delete button', async ($, on) => {
  const removed = disk(on)
  await start($, on)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

  // Open: the list replaces the second-line warning.
  expect(await band.find({ key: 'temp-chip' })).toBeUndefined()
  expect(await band.find({ text: '1.png' })).toBeDefined()
  expect(await band.find({ text: 'notes.txt' })).toBeDefined()
  expect(await band.find({ text: '  images/' })).toBeDefined()
  const del = await band.find({ key: `temp-del:${DIR}/images/1.png` })
  expect(del?.props.label).toBe('🗑')

  await band.press({ key: `temp-del:${DIR}/images/1.png` })
  expect(removed).toEqual([`${DIR}/images/1.png`])
  expect(await band.find({ text: '1.png' })).toBeUndefined()
  expect(await band.find({ text: 'notes.txt' })).toBeDefined()
  await band.unmount()
})

test('folded, the warning is its own second line under the usage row', async ($, on) => {
  disk(on)
  await start($, on)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await band.press({ key: 'cache-fold' })
  const chip = await band.find({ key: 'temp-chip' })
  expect(JSON.stringify(chip)).toContain('⚠ 2 temp files · 90 KB')
  expect(JSON.stringify(await band.find({ key: 'row' }))).not.toContain('temp files')
  await band.unmount()
})

test('Delete all asks once, Cancel keeps the files, and the confirm deletes every one', async ($, on) => {
  const removed = disk(on)
  await start($, on)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

  await band.press({ key: 'temp-delete-all' })
  expect(removed).toEqual([])
  expect(await band.find({ key: 'temp-confirm' })).toBeDefined()
  await band.press({ key: 'temp-cancel' })
  expect(await band.find({ key: 'temp-confirm' })).toBeUndefined()
  expect(removed).toEqual([])

  await band.press({ key: 'temp-delete-all' })
  await band.press({ key: 'temp-confirm' })
  expect(removed.sort()).toEqual([`${DIR}/images/1.png`, `${DIR}/scratchpad/notes.txt`])
  expect(await band.find({ key: 'temp-chip' })).toBeUndefined()
  expect(await band.find({ key: 'temp' })).toBeUndefined()
  await band.unmount()
})
