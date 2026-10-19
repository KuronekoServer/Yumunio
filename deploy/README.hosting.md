# Yumunioをホストする / Host Yumunio

必要なものはDockerとDocker Compose 2.24以上です。このフォルダーを展開して使います。内部の認証情報は初回起動時に自動生成されます。

## 自分のPCで試す

標準の配布先はDocker Hubの `kuronekoserver/yumunio` です。対象のタグが未公開の場合は、リンク先の案内でソースからのビルド方法を確認してください。

```sh
docker compose pull
docker compose up -d
docker compose logs yumunio
```

ログの「初期設定をはじめる / Start setup」リンクを開き、名前・メールアドレス・パスワードとワークスペース名を入力します。初期設定後は http://127.0.0.1:8788 から開けます。

## ドメインを使って公開する

起動前に `.env` の `YUMUNIO_PUBLIC_ORIGIN` のコメントを外し、自分のURLを設定します。

```dotenv
YUMUNIO_PUBLIC_ORIGIN=https://notes.example.com
```

ドメインのDNSをこのサーバーへ向け、TCPの80/443番ポートを利用できる状態にします。HTTP/3も使う場合はUDPの443番ポートを開けます。すでに80/443番を別のサービスで使っている場合は、既存のHTTPSプロキシから `127.0.0.1:8788` へ接続してください。

```sh
docker compose -f compose.yaml -f compose.https.yaml pull
docker compose -f compose.yaml -f compose.https.yaml up -d
docker compose -f compose.yaml -f compose.https.yaml logs yumunio
```

同梱のCaddyがHTTPSの証明書を自動で管理します。公開URLは初回設定の前に決めてください。

## 更新・停止

更新時は最初と同じComposeファイルを指定して `pull` と `up -d` を実行します。特定のバージョンを使う場合は `.env` の `YUMUNIO_IMAGE` に指定します。一時停止は `docker compose stop`、再開は同じ構成で `up -d` です。`.env`、このフォルダー、Dockerボリュームを保持してください。`down -v` は保存データを削除するため、通常の更新には使いません。

詳細な導入、更新前のバックアップ、復旧、イメージを取得できない場合のソースビルドは [Dockerの案内](https://github.com/KuronekoServer/Yumunio/blob/master/docs/hosting/docker.md)を参照してください。

## English

Install Docker and Compose 2.24 or newer. Extract this archive and run `docker compose pull`, `docker compose up -d`, then `docker compose logs yumunio`. Open the Start setup link from the log. Internal credentials are generated automatically.

For public hosting, set your exact HTTPS URL in `.env` before the first start. Point the domain at your server and make TCP ports 80/443 available. Add `-f compose.yaml -f compose.https.yaml` to the commands to use the bundled Caddy proxy. UDP 443 is optional for HTTP/3. Keep the installation directory and all Docker volumes when updating. Follow the linked hosting guide for backup and recovery.

Docker Hub (`kuronekoserver/yumunio`) is the default registry. GHCR is an optional alternative once the package is public. Both registries distribute the same tested amd64 and arm64 images. Check that your chosen tag has been published before starting.
