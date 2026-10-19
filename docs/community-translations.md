# コミュニティ翻訳

翻訳は、リポジトリの言語別JSONを編集してPull Requestで提案できます。外部の翻訳サービスへの登録は不要です。翻訳元は日本語で、未翻訳の部分は英語で補います。ページ名、本文、添付ファイルなどの利用者のデータは翻訳用の辞書に含めません。

[English guide](community-translations.en.md) · [ドキュメント一覧](README.md)

## GitHubの画面から翻訳する

GitHubアカウントがあれば、ブラウザーだけで参加できます。Node.jsやコマンドの実行は不要です。[GitHubのファイル編集手順](https://docs.github.com/en/repositories/working-with-files/managing-files/editing-files)も参照できます。

1. 下の表から翻訳したい画面を開き、対象の言語のJSONを選びます。日本語と英語を参考にしてください。
2. 鉛筆の編集ボタンを押し、右側の文章だけを変更します。左側のキーと `{name}`、`{count}` などは残します。
3. **Commit changes / Propose changes**から変更を提案します。GitHubの案内に従って、自分のフォークや新しいブランチからPull Request（PR）を作成してください。
4. PRには言語・画面・修正の理由を書きます。ローカルで実行していなければ「GitHub上で編集、CIで確認予定」と記載して大丈夫です。
5. **Translation review**がJSON・置換部分・表示の補完を検証します。失敗した場合は、PRのチェックに出たファイルと理由を確認して修正します。

| 画面 | 日本語 | 英語 |
| --- | --- | --- |
| 共通のボタン・案内 | [locales/ja.json](../apps/web/public/locales/ja.json) | [locales/en.json](../apps/web/public/locales/en.json) |
| サイトの初期設定 | [setup-locales/ja.json](../apps/web/public/setup-locales/ja.json) | [setup-locales/en.json](../apps/web/public/setup-locales/en.json) |
| ページの編集 | [workspace-locales/ja.json](../apps/web/public/workspace-locales/ja.json) | [workspace-locales/en.json](../apps/web/public/workspace-locales/en.json) |
| データベース | [collections-locales/ja.json](../apps/web/public/collections-locales/ja.json) | [collections-locales/en.json](../apps/web/public/collections-locales/en.json) |
| 個人設定 | [prefs-locales/ja.json](../apps/web/public/prefs-locales/ja.json) | [prefs-locales/en.json](../apps/web/public/prefs-locales/en.json) |

その他の画面は[言語一覧のnamespaces](../apps/web/public/locale-manifest.json)にあります。JSONの編集が難しければ、[翻訳のIssue](https://github.com/KuronekoServer/Yumunio/issues/new?template=translation.yml)へ、言語・画面・現在の文章・提案する文章を記載してください。

## 新しい言語は一文から追加できる

たとえば、フランス語の初期設定画面なら、GitHubの **Add file → Create new file** から `apps/web/public/setup-locales/fr.json` を作成します。

```json
{
  "title": "Bienvenue dans Yumunio"
}
```

この1ファイルだけのPRで参加できます。言語一覧と、他の画面で必要な空の辞書はCIとビルド時に自動生成します。未翻訳の部分には英語を表示します。日本語・英語は全項目を維持し、それ以外は途中までの翻訳を受け付けます。PRのチェックのSummaryで言語ごとの翻訳率を確認できます。

変更はレビューとリリースを経て配布されます。稼働中のサイトには、管理者による更新後に反映されます。

## ローカルで翻訳する

1. `apps/web/public/locale-manifest.json` の `namespaces` から、翻訳する画面のフォルダーを確認します。たとえば、サイト設定は `setup-locales`、編集画面は `workspace-locales` です。
2. 同じフォルダーの `ja.json` と `en.json` を参考に、言語コードのJSONを作成・編集します。例は `apps/web/public/setup-locales/fr.json` です。途中の翻訳も提案できます。
3. キーと `{name}`、`{count}` などの置換部分を維持し、値の文章だけを翻訳します。置換部分の順番は変更できます。JSONはUTF-8で保存してください。
4. 次のコマンドで言語一覧と不足する名前空間を整え、検証してからPull Requestを作成します。

```sh
npm run l10n:sync
npm run l10n:check
npm run l10n:report -- --markdown
npm run build
```

日本語と英語は全キーを維持します。その他の言語は、訳文のある言語だけを選択肢へ追加し、未翻訳の名前空間を空の辞書として英語へフォールバックさせます。文字列のキー、不明なファイル、置換部分の変更は検証で検出します。RTLの言語では表示方向も設定します。

中国語は `zh-Hans` と `zh-Hant`、ポルトガル語は `pt-PT` と `pt-BR` を区別します。ファイル名は正規化されたBCP 47の言語コードを使ってください。翻訳はレビュー後のソフトウェア更新に含まれます。

## 外部サービスについて

通常の翻訳参加はGitHubのPRで完結します。Crowdinの利用・同期は停止したままです。

<details>
<summary>運営者向け：停止中の外部同期</summary>

単語数による費用を避けるため、Crowdinの利用・同期は停止しています。画面にCrowdinへの参加リンクは表示しません。`.github/workflows/translations.yaml` に定期実行やpushによる実行はありません。手動実行でも `enable_sync` は既定で `false` で、この指定を明示的に変更しない限り外部サービスへ接続しません。

将来再開するときのために、`crowdin.yml` と入出力の検証は残しています。利用を再開する場合は、先にサービスの単語数と料金を確認し、プロジェクトを管理する認証情報をGitHubの `CROWDIN_PERSONAL_TOKEN` に登録してください。コードやチャットへ値を貼り付けないでください。

```sh
# 日本語辞書だけをローカルのZIPへ書き出す（通信はしません）
npm run l10n:export

# 将来、取得した訳を .crowdin/<言語コード>/<名前空間>.json に置いて取り込む
npm run l10n:import
npm run l10n:check
```

書き出すのは23種類の日本語JSONと、初回登録に使う既存の英語訳だけです。ZIPは `.build/crowdin-sources.zip` に作成します。DB、環境ファイル、文書、添付は含めません。取り込みはキー・置換部分・形式を検証し、英語の未取得部分を保持します。

明示的に手動同期を有効にした場合も、承認済みの翻訳だけを取り込み、検証・テスト・ビルドの後にレビュー用のドラフトPRを作ります。自動マージやデプロイは行いません。初回の `seed_english` は既存の英訳を未承認の提案として送信するための指定です。

設定の参照元: [Crowdin設定ファイル](https://support.crowdin.com/developer/configuration-file/)、[公式GitHub Action](https://github.com/crowdin/github-action)。

</details>
