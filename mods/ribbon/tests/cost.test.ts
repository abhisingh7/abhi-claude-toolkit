import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false, isCollapsed: false, isWorking: false,
  maxRows: 12, bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 17 },
  { kind: 'seven_day', percentUsed: 45 },
]

async function costBand(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  usd: number,
  now = 0,
) {
  mock.store(on)
  mock.clock(on, { now })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS, cost: { usd } },
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
}

const colorOf = async (band: Awaited<ReturnType<typeof costBand>>, text: string) => {
  const box = await band.find({ key: 'cost' })
  const t = JSON.parse(JSON.stringify(box)) as { text?: string; children?: { props?: { color?: string } }[] }
  expect(t.text).toBe(text)
  return t.children?.[0]?.props?.color
}

test('the cost comes first, before 7D, with no dot bars after 7D or 5H', async ($, on) => {
  const band = await costBand($, on, 1.234)
  const all = JSON.stringify(await band.find({ type: 'Box' }))
  expect(all.indexOf('$1.23')).toBeGreaterThan(-1)
  expect(all.indexOf('$1.23')).toBeLessThan(all.indexOf('7D'))
  expect(all).not.toContain('●')
  expect(all).not.toContain('·····')
  await band.unmount()
})

test('under $3 the cost is green', async ($, on) => {
  const band = await costBand($, on, 2.99)
  expect(await colorOf(band, '$2.99')).toBe('#6cc070')
  await band.unmount()
})

test('from $3 to under $6 the cost is yellow', async ($, on) => {
  const band = await costBand($, on, 4.5)
  expect(await colorOf(band, '$4.50')).toBe('#f5a623')
  await band.unmount()
})

test('over $6 the cost is red and blinks between bright and dim', async ($, on) => {
  const on1 = await costBand($, on, 7.25, 0)
  expect(await colorOf(on1, '$7.25')).toBe('#e5534b')
  await on1.unmount()
})

test('over $6, the other half of the blink draws it dim', async ($, on) => {
  const off = await costBand($, on, 7.25, 700)
  expect(await colorOf(off, '$7.25')).toBe('#5a2a27')
  await off.unmount()
})
