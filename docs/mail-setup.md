# メール送信を設定する

管理者でログインし、**サーバー管理 → サイト設定 → メール送信**を開きます。初期設定時はメールなしで使い始められます。新規登録を公開する前に、メール送信を設定してテストしてください。

| ホスト | 選べる送信方法 |
| --- | --- |
| Cloudflare Workers | Cloudflare Email Service、暗号化したSMTP接続、HTTPS中継 |
| Docker / Node.js | 暗号化したSMTP接続、HTTPS中継 |

Cloudflareでホストする場合は、**Cloudflare Email Service**（送信バインディング、推奨）か**SMTP**のどちらかを設定してください。SMTPにはCloudflare Email ServiceのSMTPも使えます。Docker / Node.jsでは、SMTPかHTTPS中継のどちらかを設定します。

## Cloudflareから直接送信する

1. Cloudflareの **Compute → Email Service → Email Sending** で、送信元に使うドメインを追加します。Cloudflare DNSの利用と、案内されたDNS設定の確認が必要です。受信を転送するEmail Routingとは別の送信設定です。
2. YumunioのWorkerにメール送信の接続を追加し、名前を **EMAIL** にします。Wranglerで管理する場合は、既存設定に次を追加して再デプロイします。

   ```jsonc
   "send_email": [{ "name": "EMAIL" }]
   ```

3. Yumunioのサイト設定で **Cloudflare メール送信**を選び、そのドメインの送信元メールアドレスを入力して保存します。返信先は任意です。YumunioへCloudflareのAPI認証情報を入力する必要はありません。
4. サーバー管理のメールテストを実行し、自分の受信箱で到着を確認します。接続に送信元・宛先の制限がある場合は、認証メールや招待メールの宛先も許可されるようにCloudflare側で確認してください。

`EMAIL`が未接続の場合、画面に接続の案内を表示し、その方式での保存を拒否します。ローカル開発中の送信はシミュレーターであり、実配送の確認は実際のCloudflare環境で行います。実メールを送るremote bindingの利用は、送信先を確認した検証時に限って明示的に設定してください。

[Cloudflareの送信開始手順](https://developers.cloudflare.com/email-service/get-started/send-emails/)と[送信バインディングの設定](https://developers.cloudflare.com/email-service/configuration/send-bindings/)を参照してください。

## SMTPのメールサービスへ接続する

**メールサーバーに接続（SMTP）**を選び、提供元が案内するサーバー名、接続ポート、暗号化、ユーザー名、パスワードを入力します。通常の組み合わせは、465と「最初から暗号化」、または587と「接続後に暗号化」です。暗号化を変更すると標準ポートも切り替わります。独自のポートを入力した場合は維持します。

Cloudflare Email ServiceのSMTPを使うときは、**CloudflareのSMTP設定を入力する**を押すと、次の項目を自動入力します。

| 項目 | 値 |
| --- | --- |
| 接続先 | `smtp.mx.cloudflare.net` |
| ポート | `465` |
| 暗号化 | 最初から暗号化 |
| ユーザー名 | `api_token` |

パスワードには、Cloudflare側で発行した **Email Sending: Edit** の権限を持つ認証情報を入力します。ドメインの追加も必要です。CloudflareのSMTPは465での暗号化接続を使用します。[SMTPの公式手順](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)を参照してください。

WorkersのSMTPはNode.js互換ランタイムの暗号化ソケットを使います。Workersは25番ポート、localhost、プライベートIP、一部のCloudflare宛先へのTCP接続を制限します。保存時には25番ポートを拒否します。提供元がWorkersからの接続を許可していない場合やCloudflare自身のSMTPに接続できない場合は、Workersの直接送信またはHTTPS中継を選んでください。制約の詳細は[WorkersのTCPソケット](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)を参照してください。

どちらの実行環境でも証明書を検証し、暗号化されない接続への切り替えは行いません。認証情報は暗号化されたサイト設定に保存し、空欄で保存した場合は既存のパスワードを維持します。

## テスト結果を確認する

サイト設定を保存してから、**サーバー管理 → メール送信テスト**で自分のアドレスへの送信を依頼します。メールは既存の永続キューを経由します。キューへの登録、送信サービスによる受け付け、受信箱への到着は別の状態です。画面の「受け付け」は最終配送の証明ではありません。受信箱と迷惑メールフォルダーを確認してください。

同じテスト依頼の再送では重複ジョブを作りません。接続先のエラーや認証情報は一般公開APIへ返しません。
