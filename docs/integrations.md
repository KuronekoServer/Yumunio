# API・MCP・Webhook

いずれもNode.jsとCloudflare Workersで利用できます。初期状態は無効です。Notion API互換ではなく、現在公開している操作は次の範囲です。APIの詳細は[OpenAPI](../openapi.yaml)、起動中のサーバーでは `/openapi.yaml` を参照してください。

| 接続方法 | 現在の機能 | 主な制限 |
| --- | --- | --- |
| REST API | 許可したページの参照、タイトル・本文更新、ブロック追加・更新・削除 | 1つの接続情報につき1ページ。外部向けのページ作成、横断検索、DB・コメント・添付管理は未対応 |
| MCPサーバー | Streamable HTTP、tools、ページ本文のresource、RESTと同じ権限付き編集 | 独立した `/api/mcp`。OAuthによる接続やワークスペース全体の操作は未対応 |
| Webhook | 7種類のページイベント、署名、永続キュー、配送状況、停止・再開 | 運営者が設定するHTTPS送信先1か所。本文・ファイルは送らず、メタデータを通知 |

## 外部APIとMCPを有効にする

運営者が[追加の設定](../deploy/advanced.env.example)で `YUMUNIO_API_TOKENS_ENABLED=true` を指定します。MCPも使う場合は `YUMUNIO_MCP_ENABLED=true` を指定してください。既存DBから更新する場合は、対応するDB・認証スキーマの移行を先に行います。

利用者は `/integrations` で対象ページと、閲覧・編集・MCP接続の権限、有効期限を選びます。接続用の秘密は自動生成し、発行時だけ表示します。Cookieでのログインと外部接続は分離しており、外部クライアントは `Authorization: Bearer <発行された値>` を送信します。URLには秘密を含めません。失効・期限切れ・ページ権限の変更は各リクエストと書き込み確定時に確認します。

| REST操作 | パス |
| --- | --- |
| ページを参照 | `GET /api/v1/pages/{pageId}` |
| 本文を参照 | `GET /api/v1/pages/{pageId}/document` |
| タイトル・本文を更新 | `PATCH /api/v1/pages/{pageId}/document` |
| ブロックを部分編集 | `PATCH /api/v1/pages/{pageId}/blocks` |

書き込み前に現在の `page.version` を読み、`expectedVersion` に指定します。ブロックの部分編集は次のJSONを送信します。

```json
{
  "expectedVersion": 3,
  "operations": [
    {"type": "append", "blocks": [{"type": "paragraph", "data": {"text": "追記した文章"}}]},
    {"type": "update", "blockId": "既存ブロックのID", "data": {"text": "更新した文章"}},
    {"type": "delete", "blockId": "削除するブロックのID"}
  ]
}
```

追加するブロックのIDは省略でき、サーバーが生成します。`append` は `parentId` を指定すると、対応する既存ブロックの末尾へ追加します。省略時は本文末尾です。`update` は既存の種類に応じた `text`・`level`・`checked` のみを受け付けます。操作は配列順で1回の更新として確定し、一つでも失敗すると全体を変更しません。1回100操作、入れ子20段、公開本文1,000ブロック・200,000 UTF-8バイトなどの上限があります。

MCPクライアントのURLは `https://<公開ホスト>/api/mcp` です。同じ接続用秘密をBearer認証で指定します。利用できるツールは権限によって絞り込まれます。

- `get_page`：ページ名と現在のバージョン
- `get_document`：対応する本文ブロック
- `update_page`：タイトル、または本文全体の更新
- `edit_blocks`：上記と同じ `expectedVersion`・`operations` による部分編集

外部に返す本文は対応するテキストブロックに限り、除外数を `omittedBlocks` で返します。添付・未対応ブロック・取り込み元データがある場合も、部分編集は他の内容を保持します。外部に返していないブロックの操作や、そのブロックを含む親の削除は拒否します。本文全体の置き換えは除外ブロックがあると拒否します。

バージョンが変わった場合は409を返します。競合を自動再試行せず、現在の本文を再確認してください。応答が途切れた場合も、書き込みが済んでいる可能性があるため、参照して結果を確認してから次の操作を決めます。

## Webhookを有効にする

運営者が `YUMUNIO_WEBHOOK_ENABLED=true`、`YUMUNIO_WEBHOOK_ENDPOINT`、専用の `YUMUNIO_WEBHOOK_SIGNING_KEY` を指定します。送信先はクエリー・認証情報を含まないHTTPSのURL、署名用秘密は32バイトのランダム値を標準Base64で表した値です。公開画面やチャットへ記載しないでください。

`YUMUNIO_WEBHOOK_EVENTS` は次のイベントから選びます。既定は `page.updated` です。

- `page.updated`、`page.title.updated`、`page.document.updated`
- `page.created`、`page.moved`、`page.trashed`、`page.restored`

`/webhooks` でサーバー管理者が送信先と通知範囲を確認した後、対象ページを管理できる利用者が購読を開始します。子孫ページも含める場合は `YUMUNIO_WEBHOOK_INCLUDE_DESCENDANTS=true` を指定し、その範囲を含めて確認します。送信先やイベント範囲を変えると、改めて確認が必要です。

通知するのは `schemaVersion`・`eventId`・`eventType`・`workspaceId`・`pageId`・`version`・`occurredAt` だけです。受信側は `X-Yumunio-Timestamp` と未加工の本文を `timestamp + "." + body` の順に連結し、HMAC-SHA256を計算して `X-Yumunio-Signature` の `sha256=<hex>` と照合します。[実装済みの検証関数](../packages/identity/src/webhooks-transport.js)は署名と5分の時刻差を確認します。受信側でも `eventId` を永続的に記録して重複処理を防いでください。

配送は永続キューで管理し、再試行可能な失敗は最大4回まで送信します。送信先のリダイレクトには追従しません。本文の変更通知には外部API・MCPからの編集も含まれます。配送一覧から状態と試行回数を確認し、購読を停止・再開できます。

## 検証の範囲

ローカルのNode HTTP、公式MCP SDKクライアント、実workerd/D1による結合テストで確認します。Webhookの試験は合成の送信先を使い、署名・永続化・再送・停止・権限失効を検証します。実際に運用する送信先や第三者MCPアプリでの接続成功、本番への反映は別に確認が必要です。
