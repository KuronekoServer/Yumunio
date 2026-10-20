# Next.js と画面構成

Next.js 16.4.2のApp RouterとReact 19を使用します。ルート、レイアウト、エラー画面、各画面のマークアップを `apps/web/app/` に置きます。

## ビルドと配信

`npm run build` は共有ブラウザーモジュールをesbuildで生成し、`next build --webpack` で全画面を静的出力して、`.build/web/` にひとつの配信物を作ります。`apps/web/out/` と `.next/` は開発用の生成物です。ソースマップ、サーバーバンドル、環境ファイルを配信物に含めません。

DockerとCloudflare Workersは同じ成果物を配信し、既存の認証・文書・添付・共同編集APIを使います。画面の静的HTMLに利用者の情報を埋め込みません。ログイン後のデータは同一オリジンのAPIから取得し、閲覧権限とアカウントの一致をAPIで検証します。WorkersではD1と非公開R2、Dockerでは既存のDBとローカルディスクまたはS3互換ストレージを使います。

Next.jsの `output: 'export'` を採用しています。リクエスト時のSSR、Server Actions、Next.js側の認証Cookie処理は使わず、APIホストが処理します。配信にOpenNextやVercel専用サービスは必要ありません。[Next.jsの静的出力](https://nextjs.org/docs/app/guides/static-exports)を参照してください。

公開URLは `/setup`、`/account`、`/workspace?workspace=…&page=…` のように拡張子を省略します。以前の `.html` URLと末尾の `/` は、クエリを保持した308転送で正規URLへ移動します。`/notes` はブラウザー内ノート、`/offline` はオフライン時の案内です。API・不明なパス・プログラムファイルにHTMLを返す全域フォールバックは使いません。

Next.jsが出力するインラインの起動スクリプトとFlightデータは、ビルド時に内容ごとのハッシュを持つ同一オリジンのJSファイルへ移します。元の順序と内容を保持し、Node・Workers共通の `script-src 'self'` を維持します。`unsafe-inline` は追加しません。オフライン用キャッシュのビルド識別子にはNext.jsの出力も含めます。API応答や利用者の文書はキャッシュしません。

## 画面と編集エンジン

- `apps/web/app/`: URLごとのページ、共通レイアウト、エラー・404画面。
- `apps/web/src/setup-page.jsx`: 初期設定とサイト設定のフォーム・手順・言語切替。
- `apps/web/src/workspace-page.jsx`: サイドバー、ページ一覧、チームスペース、操作バー、保存状態。
- `apps/web/src/motion/`: パネル、サイドバーメニュー、モーダルと共通のMotionフック。`ui-motion.jsx`から公開。
- `apps/web/public/record-panel.js`: 詳細の保存確認、送信元・アカウント照合、権限喪失時の破棄、一覧へのフォーカス復帰。
- `apps/web/public/record-panel-dom.js`: Reactのホストがない場合に使うDOM表示。通常画面はReactのパネルを使用。
- `apps/web/public/motion-dialog-controller.js`: 標準dialogの開閉と既存ウィジェットをつなぎ、キャンセル制約とフォーカスを維持。
- `apps/web/public/workspace.js`: `mountWorkspace` で接続する編集エンジン。専用領域内のブロック、IME、選択、共同編集、貼り付け、保存、コレクション表示を管理。
- `apps/web/src/page-frame.jsx` と `page-runtime.jsx`: 各画面のReactマークアップと既存の管理・編集ウィジェットの接続。
- `packages/tooling/next-pages.mjs`: Next.jsのビルドと安全な配信物への変換。

Reactと編集エンジンが同じ子要素を更新しないよう、編集領域を分けています。入力中は操作バーだけを更新し、サイドバーを再描画しません。編集画面の破棄時には購読・保留タイマー・読み込み・共同編集を終了します。送信済みの書き込みを未実行とみなして再送する処理は加えません。

本文内DBや通常のコレクションの行は、`/workspace-detail`の同一オリジンのエディターを右側で開きます。Reactの表示部品はiframeを保持し、保存状態の変更では作り直しません。`record-panel.js`の保存確認が成功してから終了アニメーションへ進みます。権限を失った場合は即時に破棄します。`motion-bridge.js`は同一画面のイベントで表示用モデル・DOM参照・コールバックを渡す接続です。保存と認証はコントローラーとAPIが担当し、このイベントを外部通信用のAPIとして扱いません。

`content-events.js`は同じブラウザーのタブへ識別子と更新番号だけを通知します。受信側はAPIで現在の権限を確認して取得し直します。履歴から戻った際は通知用接続を作り直し、通知が使えなくても保存の完了と画面内の更新は継続します。

管理画面や既存の複雑なウィジェットはDOMコントローラーを継続して利用しています。画面間は通常のリンクでドキュメント単位に移動し、未保存入力の確認と各ウィジェットの初期化を維持します。ページの本文変更はAPIへ保存するため、Next.jsの再ビルドは必要ありません。画面コードを変更した場合は `npm run build` で更新します。`npm run dev` はビルド後に共通APIホストを起動します。

## デザインの基準

公開ソースだけで開発する場合は、この文書の寸法、[テーマの検証用データ](../apps/web/test/fixtures/themes.json)、[動きの基準](ui-motion.md)を参照してください。`Yumunio.pen`はローカルで管理する共有デザイン原本で、Gitとコンテナーの公開対象から除外しています。UI提案には架空データのスクリーンショットと操作手順を添えられます。

`Yumunio.pen` の「64 — Focused editor and familiar navigation」「Component / Compact sidebar」「138 — Neutral dark document」「139 — Neutral dark workspace hub」「140 — Light workspace hub」「141 — Neutral dark collection table」「142 — Neutral dark hub / contextual link controls」を基準とします。デスクトップのサイドバーは256px、ページの行は30px、操作バーは40px、標準本文は720px・上余白88pxです。全幅のページでは複数列のリンク、コールアウト、表を広く配置できます。本文のアイコンと見出しを大きくし、通常の操作と表の罫線は控えめにしています。カラムの追加操作やリンク先の補助表示はホバー・キーボードフォーカス時に表示し、本文のバージョンなどは編集オプション内にまとめます。

添付されたNotionの参考画面から、情報の階層、ページツリーの密度、標準幅と全幅の使い分けを取り入れています。Midnightテーマはチャコール系の背景と中立色の選択表示に揃えました。既定のLight、保存済みのテーマ選択、六つのテーマと個人の配色は維持します。配色はブラウザー・サーバー・テーマの検証用データ・Penの変数を一致させます。デザインを変更するときは同じ作業内で対応する `Yumunio.pen` の画面と共通部品も更新し、スクリーンショットで確認します。

[Notionのサイドバーの案内](https://www.notion.com/help/navigate-with-the-sidebar)を参考に、検索・ホーム・受信トレイ・お気に入り・自分用ページ・チームスペース・設定を整理しています。サイドバーの開閉と上部のお気に入り操作は本文の編集状態を保ったまま使えます。実装済みの機能だけを表示します。モバイルは「09 — Mobile editor」を基準にサイドバーをドロワーにし、本文の余白と操作の大きさを調整します。

初期設定で内部の認証情報を手入力させません。生成した開始リンクのフラグメントから読み取り、初期化時にアドレス欄から消去します。利用者が決めるのはアカウント、ワークスペース名、表示設定です。通常機能の対応範囲と残る差分は[機能対応表](feature-coverage.md)を参照してください。AI機能は対象外です。

メール設定の状態は「143 — Site settings / Cloudflare email」「144 — Site settings / SMTP email」に記録しています。Cloudflareの直接送信では接続状態と公式手順を表示し、SMTPでは接続先の自動入力と暗号化の案内を表示します。Crowdinとの接続は停止し、翻訳はJSONとPull Requestで提案できます。

複数ブロックを選択した状態は「145 — Block selection / copy cut paste」に記録しています。選択時に編集オプションを開き、既存の共通ボタンでコピー・切り取り・複製・削除を表示します。Shift+矢印では範囲を拡大・縮小でき、通常の文字編集へ戻るとブロック選択を解除します。
