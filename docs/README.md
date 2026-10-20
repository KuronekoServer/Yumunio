# Yumunioのドキュメント

初めて使う方、ホストする方、翻訳・開発に参加する方の入口です。[English](README.en.md)

| やりたいこと | 読むページ |
| --- | --- |
| 自分でホストする方法を選ぶ | [ホスティングの入口](hosting/README.md) |
| 自分のPC・VPSに導入する | [DockerとHTTPS](hosting/docker.md) |
| Cloudflareへ導入する | [Workers・D1・R2](hosting/cloudflare.md) |
| 更新やバックアップを行う | [運用と復旧](hosting/maintenance.md) |
| 起動・ログインで困っている | [トラブルシューティング](hosting/troubleshooting.md) |
| ページを編集する | [基本操作](editing-basics.md) |
| 本文に一覧を置き、詳細を編集する | [本文内DBと右側の詳細](inline-databases.md) |
| DBの新しい項目にひな形を使う | [DBテンプレートと自動項目](database-templates.md) |
| 共通の内容を複数ページで使う | [同期ブロック](synced-blocks.md) |
| メールを設定する | [Cloudflare Email Service・SMTP](mail-setup.md) |
| 外部アプリと接続する | [API・MCP・Webhook](integrations.md) |
| 翻訳に参加する | [GitHubで1文から翻訳](community-translations.md) / [English](community-translations.en.md) |
| 機能の対応範囲を確認する | [機能対応表](feature-coverage.md) |
| 開発する | [貢献方法](../CONTRIBUTING.md)・[画面構成](frontend-architecture.md) |
| UIの動きを調整する | [時間・操作・実装の方針](ui-motion.md) |
| 配布物を公開する | [メンテナー向けの公開手順](maintainers/releasing.md) |
| Docker Hubの公開を接続する | [Docker Hubの初回設定](maintainers/dockerhub.md) |

設定項目の一覧は[基本の環境ファイル](../.env.example)と[詳細設定](../deploy/advanced.env.example)、APIの仕様は[OpenAPI](../openapi.yaml)を参照してください。

Yumunioは開発中です。ローカルのテスト、GitHub Actions、配布イメージの公開、本番での動作確認は、それぞれ別の確認結果として扱います。ホスティング先の料金・利用制限は、そのサービスの案内を確認してください。
