#!/usr/bin/env bash
# Sets this repository's commit identity and GPG signing, so commits made on
# any machine are authored as SASAPIYO and show as Verified on GitHub.
#
# Run once per clone:  ./scripts/setup-git-identity.sh
# Settings go to this repository's .git/config only (not your global config).
set -euo pipefail

NAME="SASAPIYO"
EMAIL="22128441+sasagar@users.noreply.github.com"
KEY_FPR="3FC52E7A990598080D40843CC872B16845393388"
PUBKEY_URL="https://github.com/sasagar.gpg"

cd "$(git rev-parse --show-toplevel)"

git config user.name "$NAME"
git config user.email "$EMAIL"
git config user.signingkey "$KEY_FPR"
git config commit.gpgsign true
git config tag.gpgsign true
echo "✓ repo identity: $NAME <$EMAIL>, signing key $KEY_FPR"

if ! command -v gpg >/dev/null 2>&1; then
  echo "✗ gpg が見つかりません。GnuPG を入れてから再実行してください。" >&2
  exit 1
fi

if ! gpg --list-secret-keys "$KEY_FPR" >/dev/null 2>&1; then
  cat >&2 <<MSG
✗ このマシンに署名用の秘密鍵 ($KEY_FPR) がありません。
  鍵があるマシンで書き出して、こちらで取り込んでください:
    (鍵のあるマシン)  gpg --export-secret-keys --armor $KEY_FPR > signing-key.asc
    (このマシン)      gpg --import signing-key.asc && rm signing-key.asc
  ※ signing-key.asc は秘密鍵です。安全な経路で受け渡し、取り込んだら削除してください。
MSG
  exit 1
fi

# The noreply address must be one of the key's identities for GitHub to mark
# commits Verified. Pull the updated public key (which carries it) if missing.
if ! gpg --list-keys --with-colons "$KEY_FPR" | awk -F: '$1=="uid" && $2!="r"{print $10}' | grep -qF "<$EMAIL>"; then
  echo "… 鍵に $EMAIL の ID がないので、GitHub の公開鍵から取り込みます"
  curl -fsSL "$PUBKEY_URL" | gpg --import 2>&1 | sed 's/^/  /'
fi

if gpg --list-keys --with-colons "$KEY_FPR" | awk -F: '$1=="uid" && $2!="r"{print $10}' | grep -qF "<$EMAIL>"; then
  echo "✓ key has identity <$EMAIL>"
else
  echo "✗ 鍵に <$EMAIL> の ID がありません。gpg --quick-add-uid $KEY_FPR \"$NAME <$EMAIL>\" を実行し、公開鍵を GitHub に登録し直してください。" >&2
  exit 1
fi

# Sign a throwaway object to confirm the agent can sign (may ask for the passphrase).
if echo test | gpg --local-user "$KEY_FPR" --clearsign >/dev/null 2>&1; then
  echo "✓ signing works"
else
  echo "✗ 署名に失敗しました。gpg-agent / pinentry の設定を確認してください。" >&2
  exit 1
fi
