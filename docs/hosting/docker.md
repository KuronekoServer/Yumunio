# Dockerでホストする

[ホスティングの入口](README.md) / [運用と復旧](maintenance.md) / [困ったとき](troubleshooting.md)

Docker EngineまたはDocker Desktopと、Docker Compose **2.24以上**を使います。Node.jsは、配布ZIPを使う導入では不要です。対応する配布イメージはamd64とarm64です。Composeの `env_file.required` は[Docker公式の2.24以降の仕様](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)を使用します。

## Docker Hubから直接起動する

Docker Hubの [`kuronekoserver/yumunio`](https://hub.docker.com/r/kuronekoserver/yumunio) で、amd64／arm64向けの `latest` を公開しています。次のコマンドで起動できます。

```sh
docker pull kuronekoserver/yumunio:latest
docker run -d --name yumunio --restart unless-stopped -p 127.0.0.1:8788:8788 -v yumunio-data:/app/.data kuronekoserver/yumunio:latest
docker logs yumunio
```

ログに表示されるリンクからWebで初期設定します。DB・添付・内部の認証情報は `yumunio-data` へ保存されます。`docker run` の例は自分のPCで試す構成です。公開URLとHTTPSを使う場合は、下記のCompose構成を使います。`docker run` とComposeでは既定のボリューム名が異なるため、導入後は同じ起動方法・保存先を使ってください。

Publicリポジトリの取得には公開者の接続情報は不要です。[Docker Hubの公開範囲](https://docs.docker.com/docker-hub/repos/manage/access/)と[取得回数の制限](https://docs.docker.com/docker-hub/usage/)はDocker公式で確認できます。

## 配布ZIPから始める

[Releases](https://github.com/KuronekoServer/Yumunio/releases)で `yumunio-hosting.zip` と `yumunio-hosting.zip.sha256` を取得して展開します。ZIPがまだ公開されていない場合や、配布イメージを取得できない場合は[ソースからビルド](#ソースからビルドする)してください。

内容は `compose.yaml`、`compose.https.yaml`、`deploy/Caddyfile`、`.env`、案内、ライセンスです。`.env`には基本設定の例だけを含み、認証情報は初回起動時に生成します。WindowsのエクスプローラーやmacOSのFinderで展開でき、Linuxでも通常のZIP展開が使えます。

標準はDocker Hubを参照します。バージョンを固定する場合は、`.env` に `YUMUNIO_IMAGE=docker.io/kuronekoserver/yumunio:公開済みバージョン` を設定します。GHCRのPublicパッケージから取得する場合は、代わりに次を設定できます。タグは両方の配布先で `latest` または公開済みのバージョンを使います。

```dotenv
YUMUNIO_IMAGE=ghcr.io/kuronekoserver/yumunio:latest
```

展開したフォルダーで次を実行します。

```sh
docker compose pull
docker compose up -d
docker compose logs yumunio
```

ログに表示される「初期設定をはじめる / Start setup」のリンクを開きます。アカウントとワークスペースを作成したら、次回からは http://127.0.0.1:8788 を開けます。コンテナーはホストのループバックだけへ公開し、LANやインターネットから直接アクセスする構成にはしていません。

## ドメインとHTTPSを使う

1. 自分のドメインを用意し、そのDNSを導入先サーバーへ向けます。
2. 初回起動の前に `.env` のコメントを外し、実際のURLへ変更します。
3. TCPの80/443番ポートを利用できる状態にします。HTTP/3も使う場合はUDPの443番を開けます。ドメインとポートの準備はサーバーの管理者が行います。

```dotenv
YUMUNIO_PUBLIC_ORIGIN=https://notes.example.com
```

```sh
docker compose -f compose.yaml -f compose.https.yaml pull
docker compose -f compose.yaml -f compose.https.yaml up -d
docker compose -f compose.yaml -f compose.https.yaml logs yumunio
```

同梱のCaddyが証明書の取得と更新を行い、内部の `yumunio:8788` へ接続します。DNSとポートが正しく到達できることが必要です。[Caddyの自動HTTPS](https://caddyserver.com/docs/automatic-https)を参照してください。Caddyの証明書はアプリとは別の永続ボリュームへ保存します。

すでにHTTPSのプロキシを運用している場合は、`compose.https.yaml` を追加せず、既存のプロキシから `127.0.0.1:8788` へ接続します。元のHostヘッダーを保持し、アプリの公開URLと一致させてください。公開URLは初期設定後も同じ値を使います。

## ソースからビルドする

GitとDockerを使い、手元のソースからビルドする方法です。開発中の変更を試す場合にも利用できます。

```sh
git clone https://github.com/KuronekoServer/Yumunio.git
cd Yumunio
```

`.env.example` を `.env` にコピーします。Linux・macOSでは `cp .env.example .env`、PowerShellでは `Copy-Item .env.example .env` を使えます。公開する場合は先にURLを設定します。

```sh
docker compose -f compose.yaml -f compose.build.yaml up --build -d
docker compose -f compose.yaml -f compose.build.yaml logs yumunio
```

HTTPSも同梱する場合は、公開URL・DNS・ポートを用意して次を実行します。

```sh
docker compose -f compose.yaml -f compose.build.yaml -f compose.https.yaml up --build -d
docker compose -f compose.yaml -f compose.build.yaml -f compose.https.yaml logs yumunio
```

更新は、取得したタグ・コミットを確認したうえで同じファイル構成を再ビルドします。

## 導入用フォルダーを自動で用意する

すでにソースとNode.js環境がある場合は、空の導入用フォルダーと設定を生成できます。

```sh
npm run hosting:prepare -- --directory yumunio-host --origin https://notes.example.com --https
cd yumunio-host
docker compose -f compose.yaml -f compose.https.yaml pull
docker compose -f compose.yaml -f compose.https.yaml up -d
docker compose -f compose.yaml -f compose.https.yaml logs yumunio
```

既存のフォルダーや `.env` は上書きしません。すでに動作している環境の更新には、この生成コマンドを繰り返す必要はありません。自動HTTPSを使わない場合は `--https` を省略し、ローカルで試す場合は `--origin` も省略します。

配布先や版を明示したい場合は `--image docker.io/kuronekoserver/yumunio:公開済みバージョン` を追加して生成できます。省略時はDocker Hubの `latest` を使います。

## 保存先と設定

共同編集はNode.js内のWebSocketサーバーがYjsの差分を即時配信します。追加のポートや認証情報は不要で、HTTPと同じ8788番を使います。Caddy・EasyPanelなどの前段プロキシではWebSocketのアップグレードを通してください。標準構成はアプリ1インスタンスです。複数レプリカ間のWebSocket配信は未対応です。

標準の `yumunio-data` ボリュームは、DB・添付・内部の認証情報を保存します。`.env` とボリュームは、再起動・コンテナー更新でも保持してください。通常の更新で `docker compose down -v` を使うと保存データが削除されます。

サイト名・言語・テーマ・登録方針・メールは、管理者でログインしてサイト設定から変更できます。DB・S3互換保存先・APIなどの設定は[詳細設定](../../deploy/advanced.env.example)を参照してください。[初期設定後のメール](../mail-setup.md)、[更新前のバックアップ](maintenance.md)も確認してください。
