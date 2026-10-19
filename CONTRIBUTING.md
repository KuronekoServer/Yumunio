# Contributing

バグ報告、改善提案、実装、翻訳への参加を歓迎します。大きな変更は、目的と利用例をIssueで共有してから進めてください。

[行動規範](CODE_OF_CONDUCT.md)を守り、[Issueフォーム](https://github.com/KuronekoServer/Yumunio/issues/new/choose)から報告・提案の種類を選んでください。不具合では、環境、操作手順、期待した結果、実際の結果を記載します。実データを含まない短い再現例があると確認しやすくなります。脆弱性の報告は[SECURITY.md](SECURITY.md)の非公開窓口へお願いします。

## ブラウザーから参加する

翻訳とドキュメントの修正はGitHubの編集ボタンからPRで提案できます。Node.jsのインストールは不要です。[翻訳の手順](docs/community-translations.md)（[English](docs/community-translations.en.md)）と[ドキュメント一覧](docs/README.md)から対象を選んでください。一文だけの提案も受け付けます。

ドキュメントを変更するときは、利用者向けの操作手順と運営者向けの設定を区別し、初回導入・更新・復旧のどれに使う説明かを明記します。例には架空のドメインとデータを使ってください。CIでローカルリンクを検査します。

## 開発環境

Node.js 24.16.0以上とnpmを使います。

```sh
npm ci
npm run dev
```

インフラの接続情報は[.env.example](.env.example)を参考に、ローカルの`.env`へ設定します。初回起動・DB・Workersの設定は[README.md](README.md)を参照してください。

## ソース構成

| パス | 内容 |
| --- | --- |
| `apps/web` | ブラウザーUIと翻訳カタログ |
| `apps/server` | Node.jsサーバーと運用CLI |
| `apps/worker` | Cloudflare Workers、D1スキーマとマイグレーション |
| `packages` | ドメイン、認証、保存、移行、共同編集などの共通実装 |
| `openapi.yaml` | 公開APIの仕様 |

Node.jsとWorkersで同じデータや権限を扱う変更は、共通実装にまとめてください。特定の環境だけで動作するAPIを共通モジュールへ持ち込まないようにします。

自動テストは各モジュールの `test/`、実ランタイム・DB接続の検証は `integration/` に置きます。共通のテスト実行スクリプトとヘルパーは `packages/tooling/test/` にまとめ、通常のビルド・配布用ツールと分離します。Dockerではこれらのディレクトリをビルド対象から除外します。Workersには実行コードと `.build/web` の配信物をデプロイします。

## 変更時の確認

```sh
npm run l10n:sync
npm run check
npm test
npm run test:worker
```

`npm test`は必要な静的配信物をビルドしてから実行します。`test:worker`はローカルのWorkersランタイムを使います。SQL接続に関わる変更は、専用のテスト用DBを用意して`npm run test:databases`も実行してください。

PRには、変更の目的、利用者への影響、実行した確認を記載してください。権限や保存形式を変える場合は、既存データの扱いと移行方法も説明してください。APIを変える場合は`openapi.yaml`と契約テストを一緒に更新します。

対応するIssueがある場合はPRから参照し、UIを変えた場合は架空データを使った画像や操作例を添えてください。まだ実行していない確認は、その理由とともに区別して記載します。コードの生成方法にかかわらず、投稿者が内容を理解し、動作と配布できる権利を確認してください。

## 翻訳

コミュニティ翻訳は言語ごとのJSONを編集し、Pull Requestで提案してください。翻訳元は日本語です。手順は[コミュニティ翻訳](docs/community-translations.md)を参照してください。Crowdinとの接続は停止中です。

UIの翻訳は`apps/web/public/locales/`と機能別の`*-locales/`にあるJSONで管理します。日本語と英語のキー、置換用変数、意味をそろえ、利用者向けの文言をコードへ直接追加しないようにしてください。`npm run l10n:check`で検証できます。

新しい言語は翻訳JSONを1ファイル追加するだけで提案できます。CIとビルド時の `l10n:sync` が選択UIとフォールバックに使う一覧を生成します。ローカルでも `npm run l10n:sync`、`npm run l10n:check`、`npm run l10n:report -- --markdown` で確認できます。

## ホスティングと配布の案内を変更する

[導入ガイド](docs/hosting/README.md)と[リリース確認](docs/maintainers/releasing.md)を更新してください。`npm run docs:check` でリンクを検証し、配布ファイルを変えたら `npm run hosting:bundle` で導入ZIPを作り直します。Docker・Workers・CI・公開環境で実際に確認した範囲を区別してください。

## データとライセンス

実ユーザーのエクスポート、DB、添付、認証情報、`.env`、生成した配信物・検証記録はコミットしないでください。テストには架空データを使います。公開IssueやPRにも秘密値・個人情報を含めないでください。

貢献はこのプロジェクトの[MITライセンス](LICENSE)で取り込めるものを送ってください。第三者のコードや素材を使う場合は出典とライセンスを記載し、必要な著作権・ライセンス通知を保持します。依存パッケージを追加・変更した場合は、[第三者通知](THIRD-PARTY-NOTICES.md)とブラウザー配信物の通知生成への影響も確認してください。
