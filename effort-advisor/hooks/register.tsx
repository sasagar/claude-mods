import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'
import {
  LEVELS,
  buildAdvice,
  classifyByRules,
  idx,
  isTaskBoundary,
  mergeConfig,
  modelSpec,
} from './classify'
import type { Classifier, Config, Level, Verdict } from './classify'
import { DEFAULT_CONFIG } from './defaults'

// Swap point: a Haiku-based classifier with the same signature goes here.
const classifier: Classifier = classifyByRules

const snapshot = atom({ plugin: 'effort-advisor', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})

const CONFIG_NAME = '.claude/effort-advisor.json'
const OPT_KEEP = '今のまま続ける'
const OPT_MUTE = 'このセッションでは聞かない'

function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

function evidence(verdict: Verdict, current: Level, side: 'up' | 'down'): string[] {
  return verdict.hits
    .filter(h => (side === 'up' ? idx(h.rule.level) > idx(current) : idx(h.rule.level) < idx(current)))
    .map(h => `${h.rule.id} → ${h.rule.level}（スコア ${h.score.toFixed(2)}、検出: ${h.matched.join(' ')}）`)
}

/** The change dialog. Dismissed, or nobody to ask (-p): keep. */
async function askChange($: EngineInterface, message: string, to: Level): Promise<'change' | 'keep' | 'mute'> {
  const change = `${to} に変更`
  try {
    const answer = await $.ui.ask(`${message}\n\neffort を変更しますか？`, {
      options: [change, OPT_KEEP, OPT_MUTE],
      header: 'effort',
    })
    return answer === change ? 'change' : answer === OPT_MUTE ? 'mute' : 'keep'
  } catch {
    return 'keep'
  }
}

function statusLine(s: Snapshot): string | undefined {
  if (s.display !== 'status' && s.display !== 'both') return undefined
  return `${shortModel(s.model)} / effort ${s.current} / 推奨 ${s.recommended ?? '—'}${s.isMismatch ? ' ⚠ 不一致' : ''}`
}

export const register: Register = on => {
  let lastPromptAt: number | null = null
  let promptCount = 0
  let isMuted = false
  let isDeclinedThisTask = false
  let lastSuggested: { level: Level; count: number; at: number } | null = null
  // The level chosen in the dialog: sent on the main loop's requests from this
  // turn on. With applyMode "command", /effort also runs when the turn ends.
  let override: Level | null = null
  let pendingCommand: Level | null = null
  // What the last main-loop request was sent with, after this mod's rewrite.
  let lastSent: string | null = null
  // The last judgment, for /effort-advise ask.
  let lastVerdict: Verdict | null = null
  let lastConfig: Config = DEFAULT_CONFIG

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'effort-advise',
      description: '直近の effort 判定の理由を表示（ask: 変更するか確認 / config: 設定ファイルを作成 / reset: 再び聞く）',
      argumentHint: '[ask|config|reset]',
    })
    const model = await $.session.model()
    const env = await $.env.get('CLAUDE_EFFORT')
    const home = (await $.env.get('HOME')) ?? ''
    let config: Config = DEFAULT_CONFIG
    try {
      config = mergeConfig(DEFAULT_CONFIG, JSON.parse(await $.fs.read(`${home}/${CONFIG_NAME}`)))
    } catch {
      // No file, or not JSON: the defaults stand.
    }
    const current = isLevel(env) ? env : modelSpec(model, config).default
    const first = await update($, snapshot, prev =>
      prev ? { ...prev, display: config.display } : {
        display: config.display,
        model,
        current,
        judgedFrom: current,
        recommended: null,
        confidence: 0,
        isMismatch: false,
        decision: 'まだ判定していません',
        prompt: '',
        reasons: [],
        notes: [],
        scores: {},
        message: null,
        upEvidence: [],
        downEvidence: [],
        at: 0,
      },
    )
    $.ui.status(first ? statusLine(first) : undefined)
    lastPromptAt = null
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    const now = await $.clock.now()
    const idleMs = lastPromptAt === null ? null : now - lastPromptAt
    lastPromptAt = now
    promptCount += 1

    const home = (await $.env.get('HOME')) ?? ''
    let config: Config = DEFAULT_CONFIG
    try {
      config = mergeConfig(DEFAULT_CONFIG, JSON.parse(await $.fs.read(`${home}/${CONFIG_NAME}`)))
    } catch {
      // No file, or not JSON: the defaults stand.
    }

    const model = await $.session.model()
    const env = await $.env.get('CLAUDE_EFFORT')
    const current: Level = override ?? (isLevel(env) ? env : modelSpec(model, config).default)
    const turns = await $.session.turns()

    const verdict = await classifier({ text: e.text, model }, config)
    lastVerdict = verdict
    lastConfig = config
    const { advice, why } = buildAdvice(verdict, current, config)
    const boundary = isTaskBoundary({ text: e.text, turns, idleMs }, config)
    if (boundary.ok) isDeclinedThisTask = false

    const cooldownHit =
      advice !== null &&
      lastSuggested !== null &&
      lastSuggested.level === advice.to &&
      (promptCount - lastSuggested.count < config.cooldown.prompts ||
        now - lastSuggested.at < config.cooldown.minutes * 60_000)

    let decision: string
    let shouldAsk = false
    if (!advice) decision = `提案なし：${why}`
    else if (isMuted) decision = '提案なし：このセッションでは聞かない設定'
    else if (!boundary.ok) decision = `提案を見送り：タスクの途中（${boundary.why}）。キャッシュを保つため切れ目でのみ提案`
    else if (isDeclinedThisTask) decision = '提案を見送り：このタスクでは「今のまま」が選ばれた'
    else if (cooldownHit) decision = `提案を見送り：同じ推奨（${advice.to}）のクールダウン中`
    else {
      decision = `提案した（${boundary.why}）`
      shouldAsk = true
    }

    const next1: Snapshot = {
      display: config.display,
      model,
      current,
      judgedFrom: current,
      recommended: verdict.level,
      confidence: verdict.confidence,
      isMismatch: verdict.level !== null && !verdict.accept.includes(current),
      decision,
      prompt: e.text.slice(0, 80),
      reasons: verdict.hits.map(h => `${h.rule.id}（${h.rule.level}）: ${h.matched.join(' ')}`),
      notes: verdict.notes,
      scores: verdict.scores as Record<string, number>,
      message: advice?.message ?? null,
      upEvidence: evidence(verdict, current, 'up'),
      downEvidence: evidence(verdict, current, 'down'),
      at: now,
    }
    await update($, snapshot, () => next1)
    $.ui.status(statusLine(next1))

    if (shouldAsk && advice) {
      lastSuggested = { level: advice.to, count: promptCount, at: now }
      const answer = await askChange($, advice.message, advice.to)

      if (answer === 'change') {
        override = advice.to
        pendingCommand = config.applyMode === 'command' ? advice.to : null
        const after = await update($, snapshot, s => (s ? { ...s, current: advice.to, isMismatch: false, decision: `${advice.to} に変更を選択` } : s))
        $.ui.status(after ? statusLine(after) : undefined)
      } else if (answer === 'mute') {
        isMuted = true
        await update($, snapshot, s => (s ? { ...s, decision: 'このセッションでは聞かない を選択' } : s))
      } else {
        isDeclinedThisTask = true
        await update($, snapshot, s => (s ? { ...s, decision: '今のまま続ける を選択' } : s))
      }
    }

    return next(e)
  })

  // Apply the chosen level to the main loop's requests right away.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (override !== null && e.effort !== override) {
      lastSent = `${override}（MOD が ${e.effort ?? '既定'} から書き換え）`
      return yield* next({ ...e, effort: override })
    }
    lastSent = e.effort === undefined ? '既定' : String(e.effort)
    return yield* next(e)
  })

  // Make it the session's level once the turn is over.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && pendingCommand !== null) {
      const level = pendingCommand
      pendingCommand = null
      void $.command
        .run({ command: 'effort', args: level })
        .then(() => {
          override = null
          $.ui.toast(`effort を ${level} にしました（/effort ${level}）`)
        })
        .catch(() => {
          $.ui.toast(`/effort ${level} を自動で実行できませんでした。このセッションの間は MOD が ${level} を適用し続けます。恒久的に変えるには /effort ${level} を実行してください`, { timeoutMs: 10000 })
        })
    }
    return done
  })

  on('command.run', { command: 'effort-advise' }, async ($, e) => {
    const arg = e.args.trim()
    const home = (await $.env.get('HOME')) ?? ''
    const path = `${home}/${CONFIG_NAME}`

    if (arg === 'config') {
      try {
        await $.fs.read(path)
        return { text: `設定ファイルは既にあります: ${path}` }
      } catch {
        await $.fs.write(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
        return { text: `既定の設定を書き出しました: ${path}\n判定ルール（rules）・キーワード・理由テンプレート（reason / ifUp / ifDown）・クールダウン（cooldown）を編集できます。次のプロンプトから反映されます。` }
      }
    }
    if (arg === 'ask') {
      const s = await read($, snapshot)
      if (!lastVerdict || !s || s.at === 0) return { text: 'まだプロンプトを判定していません。' }
      // Judge against the level in force now (a choice since then counts).
      if (!isLevel(s.current)) return { text: '現在の effort が分かりません。' }
      const current = s.current
      const { advice, why } = buildAdvice(lastVerdict, current, lastConfig, { force: true })
      if (!advice) return { text: `変更の提案はありません（${why}）。` }
      const answer = await askChange($, advice.message, advice.to)
      if (answer === 'change') {
        override = advice.to
        pendingCommand = lastConfig.applyMode === 'command' ? advice.to : null
        const after = await update($, snapshot, x => (x ? { ...x, current: advice.to, isMismatch: false, decision: `${advice.to} に変更を選択（/effort-advise ask）` } : x))
        $.ui.status(after ? statusLine(after) : undefined)
        return { text: `次のリクエストから ${advice.to} で送ります。` }
      }
      if (answer === 'mute') {
        isMuted = true
        return { text: 'このセッションでは自動の提案をしません（/effort-advise ask と reset は使えます）。' }
      }
      return { text: `${current} のまま続けます。` }
    }
    if (arg === 'reset') {
      isMuted = false
      isDeclinedThisTask = false
      lastSuggested = null
      return { text: '提案の抑止を解除しました。' }
    }

    const s = await read($, snapshot)
    if (!s || s.at === 0) return { text: 'まだプロンプトを判定していません。' }
    const lines = [
      `直近の判定（"${s.prompt}${s.prompt.length >= 80 ? '…' : ''}"）`,
      `  モデル: ${shortModel(s.model)} / 現在: ${s.current} / 推奨: ${s.recommended ?? '—'} / 確信度: ${s.confidence}`,
      `  結果: ${s.decision}`,
      `  直近のリクエストの effort: ${lastSent ?? '—'}`,
      '',
      '一致したルール:',
      ...(s.reasons.length ? s.reasons.map(r => `  - ${r}`) : ['  （なし）']),
      ...(s.notes.length ? ['', '補足:', ...s.notes.map(n => `  - ${n}`)] : []),
      '',
      `上げる根拠（判定時の ${s.judgedFrom} より上を指すルール）:`,
      ...(s.upEvidence.length ? s.upEvidence.map(r => `  - ${r}`) : ['  （なし）']),
      `下げる根拠（判定時の ${s.judgedFrom} より下を指すルール）:`,
      ...(s.downEvidence.length ? s.downEvidence.map(r => `  - ${r}`) : ['  （なし）']),
      ...(s.message ? ['', '提案文:', ...s.message.split('\n').map(l => `  ${l}`)] : []),
      '',
      ...(s.recommended !== null && s.recommended !== s.current ? ['', `変更するか確認するには /effort-advise ask`] : []),
      `設定: ${path}（/effort-advise config で作成、/effort-advise reset で抑止を解除）`,
    ]
    return { text: lines.join('\n') }
  })

  // The status row: model / current effort / recommended, coloured on mismatch.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s || (s.display !== 'band' && s.display !== 'both')) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = s.recommended === null ? 'subtle' : s.isMismatch ? 'warning' : 'success'
    return (
      <Box>
        <Text color={color}>
          effort-advisor: {shortModel(s.model)} / effort {s.current} / 推奨 {s.recommended ?? '—'}
          {s.isMismatch ? ' ⚠ 不一致' : ''}
        </Text>
      </Box>
    )
  })
}
