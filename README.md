# Yumunio

**ノートとデータベースを、自分の場所で。**

A self-hostable, open-source workspace for notes, pages, and databases.

Yumunioは、文章と情報をひとつにまとめるMITライセンスのワークスペースです。Notionに慣れた人が使いやすい操作を目指し、Node.jsサーバーとCloudflare Workersの両方で動作します。

現在は開発中です。既存サービスとの完全な機能互換・移行互換を保証するものではありません。

[動かしてみる](#ローカルで試す) · [セルフホスト](#nodejsでセルフホストする) · [Workers](#cloudflare-workersで動かす) · [不具合・提案](https://github.com/KuronekoServer/Yumunio/issues/new/choose) · [開発に参加](CONTRIBUTING.md)

| やりたいこと | 使う構成 |
| --- | --- |
| まず操作を試す | Node.jsで起動し、ブラウザー内に保存 |
| 自分のサーバーで共有する | Node.jsまたはDockerと、選択したSQLデータベース |
| Cloudflareで共有する | WorkersとD1、必要に応じて非公開R2 |

## 主な機能

- 本文への直接入力、Markdownショートカット、ブロックのドラッグ移動、表、Undo／Redo、自動保存
- コレクションのTable／Board／List／Gallery／Calendar／Timeline／Chart／Feedビュー
- 複数ワークスペース、チームスペース、個人・ロール単位の共有、ゲスト、コメント、メンション、共同編集
- フォーム、検索、履歴、ごみ箱、ワークスペースのエクスポート、Notion／AppFlowyデータのインポート
- 6種類のテーマ、個人カラー・フォント設定、日本語／英語のJSON翻訳、インスタンスのロゴ・ブランド設定
- 任意で有効化できるGoogle／GitHub／Discord／OIDC認証、API、MCPサーバー、Webhook、暗号化バックアップ

AI生成機能は搭載していません。APIとMCPは、利用者の権限と明示したトークンの範囲でページにアクセスします。

## ローカルで試す

Node.js **24.16.0以上**とnpmが必要です。

```sh
npm ci
npm run dev
```

[http://127.0.0.1:8788](http://127.0.0.1:8788)を開きます。`.env`を作らない場合はブラウザー内に保存するモードです。アカウントを使う共有ワークスペースには、次のサーバー設定が必要です。

## Node.jsでセルフホストする

[.env.example](.env.example)を`.env`へコピーし、使用する機能を設定します。`npm start`と開発コマンドは`.env`を読み込みます。

| 保存先 | `YUMUNIO_STORAGE` | 設定 |
| --- | --- | --- |
| SQLite | `sqlite` | `YUMUNIO_DATABASE`にファイルパス |
| MariaDB／MySQL | `mariadb`／`mysql` | `YUMUNIO_DATABASE_URL`に`mysql://...` |
| TiDB | `tidb` | MySQL互換の接続先を指定 |
| PostgreSQL | `postgres` | `YUMUNIO_DATABASE_URL`に`postgres://...` |

特定のDBを推奨する構成にはしていません。TiDB／MySQLの実接続互換性は利用するバージョン・環境で確認してください。

アカウントを使う場合は、少なくとも次を設定します。

- `YUMUNIO_ACCOUNTS_ENABLED=true`
- `YUMUNIO_PUBLIC_ORIGIN`：実際に利用するURL
- `YUMUNIO_ACCESS_KEY`と`YUMUNIO_AUTH_SECRET`：それぞれ別のランダムな32文字以上の値
- アカウントを作成するためのメール送信設定と登録方針

ランダム値は、次のコマンドをそれぞれのキー用に実行して生成できます。

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

外部SQLを選んだ場合は`npm run db:migrate`、アカウントを有効にした場合は`npm run auth:migrate`を実行してから起動します。

```sh
npm start
```

新規登録は初期状態で閉じています。メール送信を設定し、必要な期間だけ`YUMUNIO_REGISTRATION_MODE=open`にすると、`/account.html`から登録・メール確認ができます。サーバー管理者は、確認済みアカウントのIDを`YUMUNIO_SERVER_ADMIN_IDS`へ明示して設定します。

Docker用の[Dockerfile](Dockerfile)と、[SQLite](compose.sqlite.yaml)・[MariaDB](compose.mariadb.yaml)・[PostgreSQL](compose.postgres.yaml)のCompose構成もあります。設定した`.env`を用意して、例えばSQLiteなら次のように起動できます。

```sh
docker compose -f compose.yaml -f compose.sqlite.yaml up --build -d
```

公開時はHTTPSを設定し、DB・添付・バックアップの保存先を永続化してください。アカウント用DBとブラウザー内ノートは別の保存領域です。

## Cloudflare Workersで動かす

WorkersではD1を使い、添付には非公開R2またはS3互換ストレージを選べます。

1. `npx wrangler login`でCloudflareへログインします。
2. [設定例](apps/worker/wrangler.accounts-r2.jsonc.example)を`apps/worker/wrangler.deploy.jsonc`へコピーします。
3. D1とR2を作り、設定ファイルのWorker名・公開URL・D1 ID・R2名を変更します。

```sh
npx wrangler d1 create yumunio
npx wrangler r2 bucket create yumunio
```

新規のD1にスキーマを適用し、別々に生成したシークレットを登録します。

```sh
npx wrangler d1 execute DB --remote --config apps/worker/wrangler.deploy.jsonc --file apps/worker/snapshot-schema.sql
npx wrangler d1 execute DB --remote --config apps/worker/wrangler.deploy.jsonc --file apps/worker/auth-schema.sql
npx wrangler secret put YUMUNIO_ACCESS_KEY --config apps/worker/wrangler.deploy.jsonc
npx wrangler secret put YUMUNIO_AUTH_SECRET --config apps/worker/wrangler.deploy.jsonc
npx wrangler deploy --config apps/worker/wrangler.deploy.jsonc
```

既存DBの更新には[マイグレーション](apps/worker/migrations/)を確認してください。登録を開くには、HTTPSメール中継と登録方針の設定が必要です。Workersのメール送信はHTTP中継を使い、Node.jsではSMTPも選べます。

## 設定と連携

接続情報・認証・メール・ストレージ・ブランドは環境変数で管理します。秘密値はNode.jsの`.env`またはWranglerのシークレットに設定してください。設定項目と初期値は[.env.example](.env.example)を参照してください。

- 添付：Node.jsのローカル保存、S3互換／Wasabi、WorkersのR2
- OAuth：プロバイダー側に`公開URL/api/auth/callback/google`などのコールバックURLを登録
- API：`YUMUNIO_API_TOKENS_ENABLED=true`。仕様は[openapi.yaml](openapi.yaml)、起動後は`/openapi.yaml`
- MCP：APIトークンに加えて`YUMUNIO_MCP_ENABLED=true`。エンドポイントは`/api/mcp`
- Webhook・バックアップ：環境変数に加え、管理画面で対象と保存先・送信先を確認して有効化

APIの公開範囲はOpenAPIに記載した操作に限ります。インポートは形式ごとに対応範囲が異なります。プレビューを確認し、元データを残して移行してください。

## 困ったとき

<details>
<summary>起動できない・新しい画面が反映されない</summary>

Node.jsが24.16.0以上か確認し、リポジトリのルートで`npm ci`を実行してください。`npm run dev`と`npm start`は配信物をビルドしてから起動します。直接サーバーファイルを実行する場合は、先に`npm run build`が必要です。

</details>

<details>
<summary>新規登録や外部ログインが表示されない</summary>

初期状態ではアカウントと外部ログインは無効、登録は閉鎖されています。アカウントを有効にしてスキーマを適用し、メール送信・登録方針、使うOAuthプロバイダーの設定を確認してください。[.env.example](.env.example)に設定項目があります。

</details>

<details>
<summary>DBを変更したい・データを移したい</summary>

接続先の変更だけでは既存データは移行されません。DBのマイグレーション、ワークスペースのインポート、インスタンスのバックアップ復旧は、それぞれ用途が異なります。移行前のデータを保持し、取り込みプレビューや復旧先を確認して進めてください。

</details>

## 開発に参加する

不具合は、使った環境・操作手順・期待した結果・実際の結果を[報告フォーム](https://github.com/KuronekoServer/Yumunio/issues/new/choose)からお知らせください。機能提案と翻訳のフォームも用意しています。権限の回避や非公開データへのアクセスに関する報告は、[セキュリティ方針](SECURITY.md)の非公開窓口へ連絡してください。

```sh
npm run check
npm test
npm run test:worker
```

構成、翻訳、変更時の確認は[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

## ライセンス

[MIT](LICENSE) — Copyright (c) 2026 KuronekoServer

依存ライブラリとフォントの扱いは[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)を参照してください。ブラウザー配信物には、同梱する依存ライブラリのライセンス通知を`/shared/THIRD_PARTY_LICENSES.txt`として含めます。

[貢献方法](CONTRIBUTING.md) · [行動規範](CODE_OF_CONDUCT.md) · [セキュリティ](SECURITY.md)
