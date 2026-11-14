import type { Level } from './classify'

// Representative prompts with the level each should get. Used by
// classify.test.ts and by the judgement table.
export const CASES: { text: string; model: string; current: Level; expect: Level | null }[] = [
  { text: 'このCSVの各行を「問い合わせ」「不具合」「要望」に分類して、ラベル付けした一覧にして', model: 'claude-opus-5-5', current: 'high', expect: 'low' },
  { text: 'TypeScript の satisfies って何？', model: 'claude-opus-5-5', current: 'xhigh', expect: 'low' },
  { text: 'ありがとう、助かった！', model: 'claude-opus-5-5', current: 'medium', expect: 'low' },
  { text: 'ヘッダーにログアウトボタンを追加して。クリックで /logout に POST するだけでOK', model: 'claude-opus-5-5', current: 'xhigh', expect: 'medium' },
  { text: '本番だけで時々 500 が出る原因を調査して。ログを見て根本原因を特定してほしい', model: 'claude-opus-5-5', current: 'medium', expect: 'high' },
  { text: '認証まわりのアーキテクチャを設計して、セッション方式とJWTのトレードオフを比較検討して', model: 'claude-opus-5-5', current: 'medium', expect: 'high' },
  { text: 'コードベース全体をリファクタして、旧APIから新APIへ全部移行して。完了条件はテストが全部通ること', model: 'claude-opus-5-5', current: 'medium', expect: 'xhigh' },
  { text: 'src/a.ts src/b.ts src/c.ts lib/d.ts の型定義を揃えて、呼び出し側も直して', model: 'claude-opus-5-5', current: 'medium', expect: 'xhigh' },
  { text: 'この関数を手順通りに厳密に書き換えて。仕様通りでないと困る', model: 'claude-haiku-5-5', current: 'low', expect: 'high' },
  { text: '短く答えて：このデッドロックの原因は何？', model: 'claude-opus-5-5', current: 'medium', expect: 'high' },
  { text: '全体をリファクタして、旧APIから新APIへ移行して', model: 'claude-sonnet-5-5', current: 'medium', expect: 'high' },
  { text: '全体をリファクタして、旧APIから新APIへ移行して', model: 'claude-opus-4-6', current: 'medium', expect: 'high' },
  { text: 'max effort で、この証明の穴を限界まで考えて', model: 'claude-opus-5-5', current: 'high', expect: 'max' },
]
