# Third-party notices

Yumunio本体は[MIT License](LICENSE)で公開しています。依存ライブラリには、それぞれのライセンスと著作権表示が適用されます。この文書は依存関係の案内であり、各ライブラリのライセンス本文を置き換えるものではありません。

## ブラウザー配信物

`npm run build` は、Next.js・Reactの画面出力、共同編集、数式、ドラッグ＆ドロップに使う依存ライブラリのライセンス本文を `.build/web/shared/THIRD_PARTY_LICENSES.txt` にまとめます。起動後は `/shared/THIRD_PARTY_LICENSES.txt` から参照できます。配信物を再配布する際は、この生成ファイルも含めてください。

現在の出力にはNext.js、React、React DOM、Scheduler、styled-jsx、Yjs、lib0、dnd-kit、Preact Signals、KaTeXのコードが含まれます。Next.js内のReact・React DOM・Scheduler・React Server DOMの通知も含めます。esbuildで収録する対象はバンドラーの入力情報から決まり、[ビルド処理](packages/tooling/build-web.mjs)に許可リストのない依存関係が現れるとビルドが失敗します。許可リストには、組み込まれた場合に備えて `isomorphic.js`（MIT）と `tslib`（0BSD）のライセンス取得先も指定しています。

## 直接利用する外部パッケージ

以下は各ワークスペースの `dependencies` にある外部パッケージです。バージョンとライセンス識別子は、[package-lock.json](package-lock.json)およびインストール済みパッケージのメタデータで確認しています。

| パッケージ | バージョン | ライセンス | 用途 |
| --- | --- | --- | --- |
| `@dnd-kit/dom` | 0.5.1 | MIT | ドラッグ＆ドロップ |
| `next` | 16.4.2 | MIT | App Routerと画面の静的出力 |
| `react` | 19.3.0 | MIT | 画面コンポーネント |
| `react-dom` | 19.3.0 | MIT | ブラウザー画面の描画 |
| `katex` | 0.19.0 | MIT | ローカル数式描画 |
| `yjs` | 13.6.33 | MIT | 共同編集 |
| `ws` | 8.22.0 | MIT | Node.jsのWebSocket共同編集 |
| `mysql2` | 3.24.6 | MIT | MySQL互換DB接続 |
| `pg` | 8.23.1 | MIT | PostgreSQL接続 |
| `@cfworker/json-schema` | 4.1.1 | MIT | JSON Schema検証 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | MCPサーバー |
| `better-auth` | 1.7.9 | MIT | アカウント認証 |
| `nodemailer` | 10.1.1 | MIT-0 | SMTP送信 |
| `zod` | 4.6.7 | MIT | 入力検証 |

`@cfworker/json-schema` のMIT表記はパッケージのメタデータに基づきます。現在のインストール内容には独立したLICENSEファイルが含まれていません。他の掲載パッケージでは、同梱のLICENSEファイルも確認しています。

## サーバー・開発ツールの配布

サーバーと開発ツールには、上表以外の推移的依存関係もあります。全依存関係はロックファイルに記録しています。ブラウザー用の生成通知は、それらすべてを列挙したものではありません。Node.jsの配布物やWorkersのバンドルを作成する場合は、実際に含める各パッケージのLICENSE・NOTICEなどの表示を確認し、必要な本文を配布物に保持してください。

依存関係を更新したときは、ライセンス変更と新しい依存関係を確認し、`npm run build` でブラウザー用の通知も更新してください。

## フォントとブランド素材

フォント選択にあるLINE Seed JPやNoto Sans JPなどの名前は、端末にインストールされたフォントを指定するためのものです。フォントのバイナリーは同梱していません。フォントやサーバー独自のロゴを追加して配布する場合は、その素材の利用条件と必要な表示を確認してください。

この文書の記載は、Yumunioのロックファイルとインストール済みパッケージのメタデータ・同梱ライセンスに基づきます。
