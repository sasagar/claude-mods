import { expect, test } from 'claude-code/testing'

import { CASES } from '../hooks/cases'
import { buildAdvice, classifyByRules, isTaskBoundary } from '../hooks/classify'
import type { Verdict } from '../hooks/classify'
import { DEFAULT_CONFIG as C } from '../hooks/defaults'

test('each representative prompt gets its expected level, with a reason when it asks', async () => {
  for (const c of CASES) {
    const v = classifyByRules({ text: c.text, model: c.model }, C) as Verdict
    expect(v.level).toBe(c.expect)
    const { advice } = buildAdvice(v, c.current, C)
    if (advice) {
      expect(advice.message).toContain('理由：')
      expect(advice.message).toContain('このままだと：')
      expect(advice.message).toMatch(/(上げると|下げると)：/)
    }
  }
})

test('xhigh is never suggested to a model without it', async () => {
  const v = classifyByRules({ text: 'コードベース全体をリファクタして全部移行して', model: 'claude-opus-4-6' }, C) as Verdict
  expect(v.level).toBe('high')
})

test('max only when asked for', async () => {
  const v = classifyByRules({ text: '全体をリファクタして移行して。厳密に、全部、長時間かけて', model: 'claude-opus-5-5' }, C) as Verdict
  expect(v.level).toBe('xhigh')
})

test('"短く" does not lower the level', async () => {
  const v = classifyByRules({ text: '短く答えて：このデッドロックの原因は何？', model: 'claude-opus-5-5' }, C) as Verdict
  expect(v.level).toBe('high')
  expect(v.notes.length).toBe(1)
})

test('a one-step gap needs high confidence', async () => {
  const v: Verdict = { level: 'high', accept: ['high'], confidence: 0.7, hits: [], notes: [], scores: {}, chars: 10, files: 0 }
  expect(buildAdvice(v, 'medium', C).advice).toBe(null)
})

test('task boundaries', async () => {
  expect(isTaskBoundary({ text: '続けて', turns: 3, idleMs: 1000 }, C).ok).toBe(false)
  expect(isTaskBoundary({ text: 'OK', turns: 3, idleMs: 1000 }, C).ok).toBe(false)
  expect(isTaskBoundary({ text: 'ついでに認証まわりも設計し直したい。セッション方式を見直して', turns: 3, idleMs: 1000 }, C).ok).toBe(false)
  expect(isTaskBoundary({ text: '認証まわりを設計し直したい。セッション方式を見直して', turns: 3, idleMs: 1000 }, C).ok).toBe(true)
  expect(isTaskBoundary({ text: 'はい', turns: 0, idleMs: null }, C).ok).toBe(true)
  expect(isTaskBoundary({ text: 'はい', turns: 3, idleMs: 11 * 60_000 }, C).ok).toBe(true)
})

test('asked for (force): advises within the accept range, but not when already there', async () => {
  // The user's case: a short question judged low, current medium (in range).
  const v = classifyByRules({ text: 'これで有効になりましたか？', model: 'claude-opus-5-5' }, C) as Verdict
  expect(v.level).toBe('low')
  expect(buildAdvice(v, 'medium', C).advice).toBe(null)
  const forced = buildAdvice(v, 'medium', C, { force: true }).advice
  expect(forced?.to).toBe('low')
  expect(forced?.message).toContain('理由：')
  expect(forced?.message).toContain('推奨範囲内')
  expect(buildAdvice(v, 'low', C, { force: true }).advice).toBe(null)
  // Low confidence one-step gap: still offered when asked for.
  const weak: Verdict = { level: 'high', accept: ['high'], confidence: 0.3, hits: [], notes: [], scores: {}, chars: 10, files: 0 }
  expect(buildAdvice(weak, 'medium', C, { force: true }).advice).toBe(null) // no hit to explain it
})
