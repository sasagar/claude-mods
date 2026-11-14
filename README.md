# claude-mods

Claude Code 用の MOD（hooks モジュールのプラグイン）を置くリポジトリです。

## effort-advisor

送信したプロンプトの内容から最適な effort を判定し、現在の effort と食い違うときだけ
「effort を変更しますか？」と理由つきで選択を促します。自動では切り替えません。

- 判定根拠・上げた/下げた場合のメリット・変えない場合のリスクを表示
- 提案はタスクの切れ目（新しい依頼の冒頭など）だけ。同じ推奨はクールダウン中に出さない
- プロンプト欄の上に「モデル / 現在の effort / 推奨 effort」を表示し、不一致時は色で示す
- `/effort-advise` で直近の判定理由を表示（`config` で設定ファイル作成、`reset` で抑止解除）
- 設定ファイル `~/.claude/effort-advisor.json` で判定ルール・キーワード・理由テンプレート・クールダウン・表示方法（`display`）・切り替え方式（`applyMode`）を編集可能

`applyMode` の既定は `session` で、選んだ effort をそのセッションのリクエストにだけ適用します。
`command` にすると `/effort <level>` も実行しますが、Claude Code はそれをモデルの既定値として保存します。

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install effort-advisor --marketplace sasagar/claude-mods
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install effort-advisor --marketplace sasagar/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `sasagar/claude-mods`, then Add plugin.

## Development

```
claude --plugin-dir ./effort-advisor
claude plugin test ./effort-advisor
```

## License

MIT
