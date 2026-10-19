# 配布とドキュメントの公開

[ドキュメントの入口](../README.md) / [貢献方法](../../CONTRIBUTING.md)

## 変更を確認する

公開対象のブランチ・コミットを確認し、既存の作業中の変更を混ぜずにレビューします。画面、API、翻訳、導入手順を変更した場合は、対応するコードと案内を同じ公開版へ含めます。

```sh
npm ci
npm run l10n:sync
npm run l10n:check
npm run l10n:report -- --markdown
npm run docs:check
npm run check
npm test
npm run test:worker
npm run hosting:bundle
```

ローカルではDockerが使えない場合もあるため、Dockerのビルド・起動や公開パッケージからの導入は別に確認します。CIは [ci.yaml](../../.github/workflows/ci.yaml)、コンテナーの公開は [container.yaml](../../.github/workflows/container.yaml) に定義しています。

## コンテナーを公開する

`master` へのpushは `latest`、`v*` タグは先頭の `v` を除いたバージョンタグを作成します。amd64とarm64のジョブ、両方を含むマニフェストの公開が成功していることを確認します。

初回はGHCRパッケージの公開範囲をPublicへ変更し、GitHubへログインしていない環境でも `docker pull ghcr.io/kuronekoserver/yumunio:<tag>` が成功することを確認します。ワークフローの定義だけで配布完了とは扱いません。

Docker Hubの公開先は `kuronekoserver/yumunio` です。[初回の接続設定](dockerhub.md)後は、同じワークフローの `dockerhub` ジョブが成功済みのGHCRイメージをコピーし、amd64・arm64のタグを公開します。Docker Hub向けに別のイメージを再ビルドすることはありません。最後に、接続情報を持たないDocker設定で公開マニフェストの両アーキテクチャを検証します。

## 導入ZIPを公開する

`npm run hosting:bundle` は `.build/yumunio-hosting.zip` と `.sha256` を生成します。対象はCompose、基本設定の例、Caddyfile、案内、ライセンスだけです。運用中の `.env`、DB、添付、検証ログは含めません。生成物を展開し、目的の公開イメージで導入できることを確認してから、対応するGitHub Releaseへ両ファイルを添付します。

## ドキュメントと翻訳

ドキュメントの入口は [docs/README.md](../README.md) です。GitHubの通常のMarkdown表示で参照でき、案内の変更もPRでレビューします。`npm run docs:check` はリポジトリ内のリンクと見出しを検査します。外部サイトの到達確認は含みません。

翻訳PRの [Translation review](../../.github/workflows/translation-check.yaml) は秘密情報を使わずに辞書を検証し、言語ごとの進捗をActionsのSummaryへ出力します。新しい言語の1ファイルだけの提案も受け付け、ビルド時に言語一覧と不足する空の辞書を生成します。日本語と英語の全キー、置換用変数は厳密に確認します。翻訳が取り込まれても、既存のセルフホスト環境にはその版の更新が必要です。

Crowdinの外部同期は停止を維持します。残っている [手動ワークフロー](../../.github/workflows/translations.yaml) は明示的なオプトインを既定で無効にしており、GitHubでの翻訳提案とは分離しています。
