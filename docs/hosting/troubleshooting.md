# 困ったとき

[ホスティングの入口](README.md) / [更新・バックアップ](maintenance.md)

| 状況 | 確認すること |
| --- | --- |
| `pull` で `denied`・`manifest unknown` | 使うイメージのタグとDocker Hubでの公開状態。GHCRを指定した場合はパッケージがPublicかも確認。配布前は[ソースビルド](docker.md#ソースからビルドする)を使用 |
| Composeが `required` を認識しない | Compose 2.24以上か。旧 `docker-compose` ではなく `docker compose version` で確認 |
| 起動しない | `docker compose ps` と `docker compose logs yumunio`。HTTPS構成では同じ `-f` を指定 |
| 初期設定を開けない | 起動ログの最新のリンクと、実際の公開URLが一致しているか。リンクの `#start=...` も含めて開く |
| 公開URLでログインできない | `.env` の `YUMUNIO_PUBLIC_ORIGIN`、DNS、プロキシが保持するHost、アクセス中のHTTPS URL |
| Caddyで証明書を取得できない | DNSの向き先、TCP 80/443の到達、別プロセスとの競合、`logs caddy` |
| 更新後に初期設定へ戻った | 保存ボリューム・`.env`・DB接続先を変更していないか。元の保存先を確認し、新しい管理者で作り直さない |
| WorkersのD1・R2を作成できない | Cloudflareアカウント、リソースの権限、R2の有効化、デプロイログ |
| メールが届かない | [メール設定](../mail-setup.md)の接続テスト、送信元ドメイン、キュー・配送履歴、受信側。送信の受け付けと到着は別に確認 |
| 新しい翻訳が選択肢にない | PRが取り込まれた版を使っているか。ソース運用では `npm run build` を実行。空の辞書だけでは新しい言語を登録しない |

初期設定のリンク、Cookie、パスワード、`.env` の内容をそのまま公開Issueへ載せないでください。問い合わせには、版、Node/Docker/Workersの構成、操作手順、秘密値を除いたエラーを添えます。[不具合の報告](https://github.com/KuronekoServer/Yumunio/issues/new?template=bug_report.yml)へ進めます。

ログが「保存済み」でも、外部メールの到着や本番反映まで確認できたことにはなりません。問題が起きている環境のURL・保存先・バージョンを区別して確認してください。
