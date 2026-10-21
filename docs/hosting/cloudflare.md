# Cloudflare Workersでホストする

[ホスティングの入口](README.md) / [運用と復旧](maintenance.md) / [困ったとき](troubleshooting.md)

CloudflareとGitHubまたはGitLabのアカウントを用意し、Cloudflare側でR2を有効にします。Workers・D1・R2・Durable Objectsの利用料や制限は各サービスで確認してください。[公式のDeploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)によるリポジトリの複製とリソースの作成を使います。

## ブラウザーから導入する

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/KuronekoServer/Yumunio)

1. ボタンを開き、使うアカウントとリポジトリを確認します。
2. Worker・D1・R2の名前を確認してデプロイします。D1はアカウントと本文、非公開R2は添付の保存先です。共同編集用のDurable Objectもテンプレートから自動作成します。R2の公開URLは有効にしません。
3. デプロイログの「初期設定をはじめる / Start setup」を開き、アカウントとワークスペースを作成します。内部の認証情報と最初の管理者は自動で設定します。

デプロイコマンドには `npm run deploy` を使います。共通のNext.js画面をビルドし、新規導入用DBを準備します。`workers.dev` の公開URLは初回設定で保存するため、事前の入力は不要です。初回設定後はログのリンクではなく、Workerの通常のURLからログインできます。

## カスタムドメインを使う

初回設定の前にドメインをWorkerへ追加し、`YUMUNIO_PUBLIC_ORIGIN=https://notes.example.com` を設定します。そのURLから初期設定を行ってください。外部ログインやメールのリンクも、この公開URLを使います。

## CLIから導入する

ソースとNode.js 24.16.0以上を用意します。

```sh
npm ci
npx wrangler login
npx wrangler d1 create yumunio
npx wrangler r2 bucket create yumunio
```

出力されたD1のIDとR2名をルートの [wrangler.jsonc](../../wrangler.jsonc) へ反映します。自分で作成したリソースが使われることを確認して、次を実行します。

```sh
npm run deploy
```

このコマンドはリモートのD1とWorkerを変更します。導入済み環境では、保存されている内部の認証情報を引き継ぎます。アクセスできない場合に新しい値へ置き換える動作はしません。

## 導入後

ページを開くと共同編集へ自動接続し、Yjsの差分と参加者・カーソル情報を同じ公開URLのWebSocket経由で同期します。同じアカウントの別端末も独立した接続として合流します。ページごとにDurable Objectが接続を仲介し、変更はD1へ保存してから確認応答と他の接続への状態配信を行います。`ROOMS` のバインディングと `PageRoom` のSQLiteクラス作成はWrangler設定に含まれているため、DOのIDや追加の接続用パスワードは入力しません。既存環境の更新でもこの設定を保持してください。

切断中の入力は開いている画面に保持し、再接続時に保存済みのYjs差分と照合します。再接続時に権限や共同編集の世代が変わっていれば入力を保持したまま停止します。画面を閉じる前には同期状態を確認してください。プロキシを追加する場合はWebSocketのアップグレードを通します。

メールは [Cloudflare Email ServiceまたはSMTP](../mail-setup.md)、外部アプリは [API・MCP・Webhook](../integrations.md) を参照してください。初期状態では新規登録を閉じています。

標準テンプレートには1分ごとの定期処理を設定し、メール・Webhookの再送などを進めます。バインディングや定期処理を手動で変更した場合は、CloudflareのWorker設定とログも確認してください。

導入用SQLは [install-migrations](../../apps/worker/install-migrations/) にあります。以前の環境変数方式で作ったDBを初期化するためのSQLではありません。既存DBの変更は、リリースの案内と [従来のマイグレーション](../../apps/worker/migrations/)を確認します。D1・R2・内部の認証情報を同じ構成のまま保持してください。
