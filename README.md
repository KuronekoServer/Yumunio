# Yumunio

**ノートとデータベースを、自分の場所で。**

A self-hostable, open-source workspace for notes, pages, and databases.

Yumunioは、文章と情報をひとつにまとめるMITライセンスのワークスペースです。Notionに慣れた人が使いやすい操作を目指し、Node.jsサーバーとCloudflare Workersの両方で動作します。

現在は開発中です。既存サービスとの完全な機能互換・移行互換を保証するものではありません。

[導入ガイド](docs/hosting/README.md) · [ドキュメント](docs/README.md) · [翻訳に参加](docs/community-translations.md) · [English guide](docs/README.en.md) · [不具合・提案](https://github.com/KuronekoServer/Yumunio/issues/new/choose) · [開発に参加](CONTRIBUTING.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/KuronekoServer/Yumunio)

| やりたいこと | 使う構成 |
| --- | --- |
| まず操作を試す | Node.jsで起動し、ブラウザー内に保存 |
| 自分のサーバーで共有する | Docker Composeで起動し、Webで管理者とワークスペースを作成 |
| Cloudflareで共有する | デプロイボタンでWorkers・D1・非公開R2を用意し、Webで初期設定 |

## 主な機能

- 本文への直接入力、Markdownショートカット、ブロックのドラッグ移動、表、Undo／Redo、自動保存
- ログイン後の本文にファイル・画像をコピペ／ドラッグして添付。画像は本文内に表示し、Excel／スプレッドシート／Webの表は行・列を保持して貼り付け可能
- コレクションのTable／Board／List／Gallery／Calendar／Timeline／Chart／Feedビュー
- 複数ワークスペース、チームスペース、個人・ロール単位の共有、ゲスト、コメント、メンション、共同編集
- フォーム、検索、履歴、ごみ箱、ワークスペースのエクスポート、Notion／AppFlowyデータのインポート
- 6種類のテーマ、個人カラー・フォント設定、日本語／英語のJSON翻訳、インスタンスのロゴ・ブランド設定
- 任意で有効化できるGoogle／GitHub／Discord／OIDC認証、API、MCPサーバー、Webhook、暗号化バックアップ

AI生成機能は搭載していません。APIとMCPは、利用者の権限と明示したトークンの範囲でページにアクセスします。

添付は1ファイル16 MiB、1回20ファイル・合計32 MiBまでです。画像の本文表示はPNG／JPEG／GIF／WebPに対応し、その他の形式はファイルとして添付します。表は最大256行・32列で、既存の表のセルにもまとめて貼り付けられます。数式はコピー元が渡す表示文字列として取り込み、結合セルは左上の値と空セルに展開します。共同編集中の添付・表の貼り付けは、共同編集を終了してから行います。

## ローカルで試す

Node.js **24.16.0以上**とnpmが必要です。

```sh
npm ci
npm run dev
```

[http://127.0.0.1:8788](http://127.0.0.1:8788)を開きます。`.env`を作らない場合はブラウザー内に保存するモードです。アカウントを使う共有ワークスペースには、次のサーバー設定が必要です。

## Node.jsでセルフホストする

Docker Hubの [`kuronekoserver/yumunio`](https://hub.docker.com/r/kuronekoserver/yumunio) で、amd64／arm64向けの `latest` を公開しています。[Docker Hubから起動](docs/hosting/docker.md#docker-hubから直接起動する)する場合、ソースの取得やNode.jsのインストールは不要です。GHCRの配布も継続します。

Dockerだけで導入する手順、同梱CaddyでHTTPSを設定する手順、ソースからのビルドは[Docker導入ガイド](docs/hosting/docker.md)を参照してください。[更新とバックアップ](docs/hosting/maintenance.md)も合わせて確認できます。Node.jsがある場合は `npm run hosting:prepare -- --directory yumunio-host --origin https://notes.example.com --https` で導入用の新しいフォルダーを生成できます。

最短の構成はDocker Composeです。[compose.yaml](compose.yaml)と[.env.example](.env.example)を同じディレクトリに置き、`.env.example`を`.env`へコピーします。認証に必要な内部情報は自動生成されるため、自分でキーやIDを作る必要はありません。

公開する場合は、起動前に`.env`へ`YUMUNIO_PUBLIC_ORIGIN=https://notes.example.com`のように実際のHTTPS URLを設定します。

```sh
docker compose pull
docker compose up -d
docker compose logs yumunio
```

ログに表示された**「初期設定をはじめる」リンク**を開きます。ブラウザーで名前・メールアドレス・パスワードを入力し、ワークスペースの名前を選べば準備完了です。メール送信や外部ログインはあとから設定できます。新規登録は初期状態で閉じています。

DB・添付・内部の認証情報は`yumunio-data`ボリュームへ保存されます。コンテナーは`127.0.0.1:8788`で待ち受けるため、公開時はリバースプロキシ等でHTTPSを設定してください。更新も同じ`pull`・`up -d`で行えます。ボリュームと`.env`を保持してください。

標準の配布イメージは`docker.io/kuronekoserver/yumunio:latest`です。[公開ワークフロー](.github/workflows/container.yaml)はmasterへのpush時にamd64／arm64イメージを公開し、`v*`タグではバージョン付きタグを公開します。フォークで配布するメンテナーは[Docker Hubの公開用接続設定](docs/maintainers/dockerhub.md)を行います。GHCRから取得する場合は、メンテナーがパッケージをPublicにしたことを確認して`YUMUNIO_IMAGE`を指定します。開発中の変更を試す場合は、リポジトリを取得してローカルビルドできます。

```sh
docker compose -f compose.yaml -f compose.build.yaml up --build -d
```

Node.jsで直接動かす場合も、同じ`.env`を置いて起動します。Webセットアップを有効にすると、空のSQLite DBとアカウント用スキーマを自動作成します。

```sh
npm ci
npm start
```

### 外部DBと詳細設定

接続先や詳細な機能設定は[deploy/advanced.env.example](deploy/advanced.env.example)を参照してください。Web初期設定では空の専用DBを使用します。データのある既存DBを新しい管理者で取り直すことはできません。

| 保存先 | `YUMUNIO_STORAGE` | 設定 |
| --- | --- | --- |
| SQLite | `sqlite` | `YUMUNIO_DATABASE`にファイルパス |
| MariaDB／MySQL | `mariadb`／`mysql` | `YUMUNIO_DATABASE_URL`に`mysql://...` |
| TiDB | `tidb` | MySQL互換の接続先を指定 |
| PostgreSQL | `postgres` | `YUMUNIO_DATABASE_URL`に`postgres://...` |

特定のDBを推奨する構成にはしていません。TiDB／MySQLの実接続互換性は利用するバージョン・環境で確認してください。

Web初期設定では、認証情報と最初の管理者IDが自動設定されます。外部SQLの接続情報は環境変数へ設定し、必要なら[MariaDB](compose.mariadb.yaml)・[PostgreSQL](compose.postgres.yaml)のCompose構成を組み合わせてください。これらの同梱DBでは`YUMUNIO_DATABASE_TLS=disable`を明示し、DBパスワードも設定します。初回のスキーマ作成は起動時に行います。

既存の環境変数だけで運用する構成も継続できます。この場合は`YUMUNIO_WEB_SETUP=false`にし、少なくとも次を設定します。

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

新規登録は初期状態で閉じています。メール送信を設定し、必要な期間だけ`YUMUNIO_REGISTRATION_MODE=open`にすると、`/account`から登録・メール確認ができます。サーバー管理者は、確認済みアカウントのIDを`YUMUNIO_SERVER_ADMIN_IDS`へ明示して設定します。

公開時はHTTPSを設定し、DB・添付・バックアップの保存先を永続化してください。アカウント用DBとブラウザー内ノートは別の保存領域です。

## Cloudflare Workersで動かす

[Workers導入ガイド](docs/hosting/cloudflare.md)に、Web初期設定・独自ドメイン・メール・更新時の保存領域をまとめています。

上の**Deploy to Cloudflare**ボタンから、Cloudflareアカウントへ構築できます。CloudflareとGitHub／GitLabのアカウントが必要です。先にCloudflare側でR2を有効にしてください。

1. Worker名・D1名・R2名を確認してデプロイします。
2. Cloudflareがリポジトリを複製し、D1と非公開R2を作成します。`npm run deploy`が必要な認証情報とDBスキーマを自動生成してWorkerをデプロイします。
3. デプロイログに表示される**「初期設定をはじめる」リンク**を開き、Web画面でアカウントとワークスペースを作成します。`workers.dev`のURLは初回設定時に保存されるため、事前のURL入力は不要です。

[Cloudflare公式のデプロイボタン仕様](https://developers.cloudflare.com/workers/platform/deploy-buttons/)に合わせ、ルートの[wrangler.jsonc](wrangler.jsonc)と`package.json`にリソースとデプロイ手順を定義しています。カスタムドメインを使う場合は、**初回設定前**にそのドメインをWorkerへ追加し、`YUMUNIO_PUBLIC_ORIGIN`を設定して、そのURLからセットアップしてください。

CLIから導入する場合は、`npm ci`・`npx wrangler login`のあと、D1／R2を作成してルートの`wrangler.jsonc`へ実際のIDと名前を反映し、デプロイします。

```sh
npx wrangler d1 create yumunio
npx wrangler r2 bucket create yumunio
npm run deploy
```

ルートの[install-migrations](apps/worker/install-migrations/)は新規導入用です。環境変数のみで運用していた既存DBには、従来の[設定例](apps/worker/wrangler.accounts-r2.jsonc.example)と[マイグレーション](apps/worker/migrations/)を使ってください。初期化SQLを既存DBへ適用しないでください。

## 設定と連携

初期設定後は、管理者でログインし、サーバー管理画面の**サイト設定**（`/setup`）から表示名・言語・テーマ・登録方針・ドメイン制限・メール・外部ログインを変更できます。WorkersではCloudflare Email Service、SMTP、HTTPS中継、Node.jsではSMTPとHTTPS中継を選べます。設定画面に接続の手順を表示します。詳細は[メール送信の設定](docs/mail-setup.md)を参照し、管理画面のメールテストと受信箱で接続・到着を確認してください。

Webで保存した設定はDBへ暗号化して保存され、対応する環境変数より優先されます。パスワードの読み戻しはできません。空欄で保存すると現在の値を保持します。Node／Dockerは`.data/instance-secret`を含む保存領域を維持してください。Workersはデプロイ時に自動登録された`YUMUNIO_INSTANCE_SECRET`を保持します。更新時に再生成されることはありません。

DB・保存先・公開URL・API／バックアップなどの追加機能は環境変数で管理します。詳細は[deploy/advanced.env.example](deploy/advanced.env.example)を参照してください。組み込みバックアップには暗号化されたサイト設定も含まれます。復旧用に、元の認証情報を含む保存領域と公開URLも保管してください。

- 添付：Node.jsのローカル保存、S3互換／Wasabi、WorkersのR2
- OAuth：プロバイダー側に`公開URL/api/auth/callback/google`などのコールバックURLを登録
- API：`YUMUNIO_API_TOKENS_ENABLED=true`。仕様は[openapi.yaml](openapi.yaml)、起動後は`/openapi.yaml`
- MCP：APIトークンに加えて`YUMUNIO_MCP_ENABLED=true`。エンドポイントは`/api/mcp`
- Webhook・バックアップ：環境変数に加え、管理画面で対象と保存先・送信先を確認して有効化

APIの公開範囲はOpenAPIに記載した操作に限ります。インポートは形式ごとに対応範囲が異なります。プレビューを確認し、元データを残して移行してください。

通常の編集操作は[編集の基本操作](docs/editing-basics.md)、接続方法と公開範囲は[API・MCP・Webhook](docs/integrations.md)、残る差分は[機能対応表](docs/feature-coverage.md)を参照してください。

## 困ったとき

<details>
<summary>起動できない・新しい画面が反映されない</summary>

Node.jsが24.16.0以上か確認し、リポジトリのルートで`npm ci`を実行してください。`npm run dev`と`npm start`は配信物をビルドしてから起動します。直接サーバーファイルを実行する場合は、先に`npm run build`が必要です。

</details>

<details>
<summary>新規登録や外部ログインが表示されない</summary>

Web初期設定後も新規登録は閉じています。管理者でログインし、サイト設定でメール送信・登録方針、使う外部ログインを設定してください。環境変数のみで運用する場合は[deploy/advanced.env.example](deploy/advanced.env.example)を参照してください。

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

## コミュニティ翻訳

コミュニティ翻訳は、言語ごとのJSONを編集してPull Requestで提案できます。[コミュニティ翻訳](docs/community-translations.md)に手順をまとめています。Crowdinとの接続は停止中です。

## ライセンス

[MIT](LICENSE) — Copyright (c) 2026 KuronekoServer

依存ライブラリとフォントの扱いは[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)を参照してください。ブラウザー配信物には、同梱する依存ライブラリのライセンス通知を`/shared/THIRD_PARTY_LICENSES.txt`として含めます。

[貢献方法](CONTRIBUTING.md) · [行動規範](CODE_OF_CONDUCT.md) · [セキュリティ](SECURITY.md)

## フロントエンドと機能対応

Next.js 16のApp RouterとReact 19を使用します。各画面は `apps/web/app/` のページとして実装し、`next build` の静的出力をNode.jsとCloudflare Workersへ配信します。認証・データ保存・添付ファイルは共通APIへ接続します。URLは `/setup`、`/account`、`/workspace` のように拡張子なしで開け、旧 `.html` URLからはクエリを保持して転送します。

`Yumunio.pen` のコンパクトサイドバー、40pxの操作バー、配色と、Notionのページ中心の画面構成を参考にしています。セットアップと編集画面のナビゲーション・操作バーはReactコンポーネントで管理し、ブロック編集や共同編集などのウィジェットは専用のDOM領域に接続します。

[画面構成](docs/frontend-architecture.md)と[Notionからの移行に向けた機能対応表](docs/feature-coverage.md)に、実装範囲と残る差分を記載しています。AI機能は対象外です。
