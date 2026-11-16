// Pure classification logic: no `$`, no engine imports. Runs inside the mod
// and directly under bun for the judgement table.
//
// To swap in a Haiku classifier later, write another function of type
// `Classifier` (it may be async and call `$.model.complete`) and pick it in
// register.tsx where `classifier` is chosen. `buildAdvice` stays the same.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Level = (typeof LEVELS)[number]

export type DirectionText = { benefit?: string; risk?: string }

export type Rule = {
  id: string
  /** What this rule points to. */
  level: Level
  /** Levels that are also fine when this rule wins (e.g. low〜medium). */
  accept?: Level[]
  /** Substrings (case-insensitive). */
  keywords?: string[]
  /** Built-in signal instead of keywords. */
  signal?: 'manyFiles' | 'longPrompt' | 'veryLongPrompt' | 'shortQuestion'
  weight: number
  /** Raise the result to at least this level when matched. */
  floor?: Level
  /** Only a note in the explanation; never moves the level. */
  noteOnly?: boolean
  /** Template; {matched} {chars} {files} are filled in. */
  reason: string
  ifUp?: DirectionText
  ifDown?: DirectionText
}

export type ModelSpec = {
  /** Substring of the model id. First match wins. */
  match: string
  default: Level
  levels: Level[]
  /** Highest level to recommend unless asked explicitly for max. */
  cap?: Level
}

export type Config = {
  /** Where model / effort / recommendation are shown: the coloured row above the prompt, the plugin status line, both, or neither. */
  display: 'band' | 'status' | 'both' | 'none'
  /**
   * How a chosen level is applied. `session`: the mod sends it on every main
   * request for the rest of this session; nothing is saved. `command`: also
   * runs `/effort <level>` when the turn ends, which Claude Code saves as the
   * model's default for new sessions.
   */
  applyMode: 'session' | 'command'
  minConfidence: number
  oneStepMinConfidence: number
  boundaryIdleMinutes: number
  boundaryMinChars: number
  continuationPatterns: string[]
  cooldown: { prompts: number; minutes: number }
  thresholds: { manyFiles: number; longPrompt: number; veryLongPrompt: number; shortQuestion: number }
  defaults: { up: Required<DirectionText>; down: Required<DirectionText> }
  rules: Rule[]
  models: ModelSpec[]
}

export type Hit = { rule: Rule; matched: string[]; score: number }

export type Verdict = {
  level: Level | null
  accept: Level[]
  confidence: number
  hits: Hit[]
  notes: string[]
  scores: Partial<Record<Level, number>>
  chars: number
  files: number
}

export type ClassifyInput = { text: string; model: string }
export type Classifier = (input: ClassifyInput, config: Config) => Verdict | Promise<Verdict>

export type Advice = {
  from: Level
  to: Level
  direction: 'up' | 'down'
  headline: string
  reason: string
  benefit: string
  risk: string
  /** The whole message, as shown in the dialog. */
  message: string
}

export const idx = (l: Level) => LEVELS.indexOf(l)

export function modelSpec(model: string, config: Config): ModelSpec {
  const id = model.toLowerCase()
  return (
    config.models.find(m => id.includes(m.match)) ?? {
      match: '*',
      default: 'high',
      levels: ['low', 'medium', 'high', 'max'],
    }
  )
}

function countFiles(text: string): number {
  const found = text.match(/[\w./-]+\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|css|scss|html|md|json|ya?ml|toml|sql|sh)\b/gi)
  return new Set(found ?? []).size
}

function fill(t: string, v: Record<string, string | number>): string {
  return t.replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : `{${k}}`))
}

export const classifyByRules: Classifier = ({ text, model }, config) => {
  const lower = text.toLowerCase()
  const chars = [...text.trim()].length
  const files = countFiles(text)
  const th = config.thresholds
  const hits: Hit[] = []
  const notes: string[] = []

  for (const rule of config.rules) {
    let matched: string[] = []
    if (rule.signal) {
      const on =
        (rule.signal === 'manyFiles' && files >= th.manyFiles) ||
        (rule.signal === 'longPrompt' && chars >= th.longPrompt && chars < th.veryLongPrompt) ||
        (rule.signal === 'veryLongPrompt' && chars >= th.veryLongPrompt) ||
        (rule.signal === 'shortQuestion' && chars <= th.shortQuestion && /[?？]\s*$/.test(text.trim()))
      if (on) matched = [rule.signal === 'manyFiles' ? `ファイル${files}件` : `${chars}文字`]
    } else {
      matched = (rule.keywords ?? []).filter(k => lower.includes(k.toLowerCase()))
    }
    if (matched.length === 0) continue
    if (rule.noteOnly) {
      notes.push(fill(rule.reason, { matched: matched.map(m => `"${m}"`).join(' '), chars, files }))
      continue
    }
    const n = Math.min(matched.length, 3)
    hits.push({ rule, matched, score: rule.weight * (1 + 0.5 * (n - 1)) })
  }

  const scores: Partial<Record<Level, number>> = {}
  for (const h of hits) scores[h.rule.level] = (scores[h.rule.level] ?? 0) + h.score

  const ranked = (Object.entries(scores) as [Level, number][]).sort((a, b) => b[1] - a[1] || idx(b[0]) - idx(a[0]))
  const first = ranked[0]
  if (!first) {
    return { level: null, accept: [], confidence: 0, hits, notes, scores, chars, files }
  }

  const [topLevel, top] = first
  let level: Level = topLevel
  // A mix of "heavy" and "light" signals leans to the heavy side when close.
  const heavier = ranked.find(([l, s]) => idx(l) > idx(topLevel) && s >= top * 0.8 && l !== 'max')
  if (heavier) level = heavier[0]

  for (const h of hits) if (h.rule.floor && idx(level) < idx(h.rule.floor)) level = h.rule.floor

  const explicitMax = hits.some(h => h.rule.level === 'max')
  if (level === 'max' && !explicitMax) level = 'xhigh'

  // Model limits: cap, then step down to a supported level.
  const spec = modelSpec(model, config)
  if (spec.cap && !explicitMax && idx(level) > idx(spec.cap)) level = spec.cap
  while (!spec.levels.includes(level) && idx(level) > 0) level = LEVELS[idx(level) - 1] ?? 'low'

  const accept = new Set<Level>([level])
  for (const h of hits) if (h.rule.level === topLevel || h.rule.level === level) for (const a of h.rule.accept ?? []) accept.add(a)

  // Confidence: how strong the chosen side is, against signals that pull two
  // or more levels the other way (neighbouring levels do not contradict it:
  // "実装して" sits fine inside a long refactor).
  const near = (Object.entries(scores) as [Level, number][])
    .filter(([l]) => Math.abs(idx(l) - idx(topLevel)) <= 1 || Math.abs(idx(l) - idx(level)) <= 1)
    .reduce((s, [, v]) => s + v, 0)
  const far = (Object.entries(scores) as [Level, number][])
    .filter(([l]) => Math.abs(idx(l) - idx(level)) >= 2 && Math.abs(idx(l) - idx(topLevel)) >= 2)
    .reduce((s, [, v]) => s + v, 0)
  const confidence = Math.round((0.6 * Math.min(1, near / 1.5) + 0.4 * (near / (near + far))) * 100) / 100

  return { level, accept: [...accept], confidence, hits, notes, scores, chars, files }
}

/** The advice to show, or null with why not. */
export function buildAdvice(
  verdict: Verdict,
  current: Level,
  config: Config,
  opts: { force?: boolean } = {},
): { advice: Advice | null; why: string } {
  // force: asked for by the user (/effort-advise ask), so the noise gates
  // (accept range, confidence) do not apply; only "already there" does.
  const force = opts.force === true
  if (!verdict.level) return { advice: null, why: '判定できる特徴がない' }
  if (verdict.level === current) return { advice: null, why: `現在の ${current} は推奨と一致` }
  const inRange = verdict.accept.includes(current)
  if (!force && inRange) return { advice: null, why: `現在の ${current} は推奨範囲内` }
  if (!force && verdict.confidence < config.minConfidence)
    return { advice: null, why: `確信度 ${verdict.confidence} が閾値 ${config.minConfidence} 未満` }
  const gap = idx(verdict.level) - idx(current)
  if (!force && Math.abs(gap) === 1 && verdict.confidence < config.oneStepMinConfidence)
    return { advice: null, why: `1段階差で確信度 ${verdict.confidence} が閾値 ${config.oneStepMinConfidence} 未満` }

  const direction = gap > 0 ? 'up' : 'down'
  const to = verdict.level
  const lead = verdict.hits
    .filter(h => h.rule.level === to || (h.rule.floor && h.rule.floor === to))
    .sort((a, b) => b.score - a.score)
  const main = lead[0] ?? [...verdict.hits].sort((a, b) => b.score - a.score)[0]
  if (!main) return { advice: null, why: '判定できる特徴がない' }
  const vars = (h: Hit) => ({ matched: h.matched.map(m => `"${m}"`).join(' '), chars: verdict.chars, files: verdict.files, from: current, to })

  const reasons = (lead.length ? lead : [main]).slice(0, 2).map(h => fill(h.rule.reason, vars(h)))
  const reason = [...reasons, ...verdict.notes].join('。')
  const dirText = (direction === 'up' ? main.rule.ifUp : main.rule.ifDown) ?? {}
  const def = config.defaults[direction]
  const benefit = fill(dirText.benefit ?? def.benefit, vars(main))
  const risk = fill(dirText.risk ?? def.risk, vars(main))
  const headline = `effort を ${current} → ${to} に${direction === 'up' ? '上げる' : '下げる'}ことを推奨します`
  const message = [
    headline,
    `理由：${reason}`,
    `${direction === 'up' ? '上げると' : '下げると'}：${benefit}`,
    `このままだと：${risk}`,
    ...(force && inRange ? [`補足：現在の ${current} も推奨範囲内です（確信度 ${verdict.confidence}）`] : []),
  ].join('\n')

  return { advice: { from: current, to, direction, headline, reason, benefit, risk, message }, why: '提案する' }
}

export type BoundaryInput = {
  text: string
  turns: number
  idleMs: number | null
}

/** Whether this prompt starts a new task (a safe moment to change effort). */
export function isTaskBoundary(b: BoundaryInput, config: Config): { ok: boolean; why: string } {
  if (b.turns === 0) return { ok: true, why: 'セッション最初の依頼' }
  if (b.idleMs !== null && b.idleMs >= config.boundaryIdleMinutes * 60_000)
    return { ok: true, why: `${config.boundaryIdleMinutes}分以上の間隔` }
  const t = b.text.trim()
  if (config.continuationPatterns.some(p => new RegExp(p, 'i').test(t))) return { ok: false, why: '会話の続き' }
  if ([...t].length < config.boundaryMinChars) return { ok: false, why: '短い返答' }
  return { ok: true, why: '新しい依頼' }
}

export function mergeConfig(base: Config, user: Partial<Config> | null): Config {
  if (!user) return base
  return {
    ...base,
    ...user,
    cooldown: { ...base.cooldown, ...(user.cooldown ?? {}) },
    thresholds: { ...base.thresholds, ...(user.thresholds ?? {}) },
    defaults: {
      up: { ...base.defaults.up, ...(user.defaults?.up ?? {}) },
      down: { ...base.defaults.down, ...(user.defaults?.down ?? {}) },
    },
    rules: user.rules ?? base.rules,
    models: user.models ?? base.models,
  }
}
