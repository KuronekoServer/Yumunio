# Docker Hubへ公開する

[公開手順](releasing.md) / [利用者向けの導入](../hosting/docker.md)

公開先は `kuronekoserver/yumunio` です。利用者は公開イメージを取得するだけで導入できます。ここに書かれた接続設定は、配布を管理する人が一度だけ行います。

## 初回の設定

1. Docker Hubで対象の名前空間へ公開する権限を持つアカウントを開き、`yumunio` リポジトリを **Public** で作成します。既存の場合は[公開範囲](https://docs.docker.com/docker-hub/repos/manage/access/)を確認します。
2. [Dockerの接続情報](https://docs.docker.com/security/access-tokens/)を用意します。公開に必要な読み取り・書き込みを許可し、削除権限は付けません。組織用の接続を使える場合は、対象をこのリポジトリへ絞ります。
3. [GitHub ActionsのVariables](https://github.com/KuronekoServer/Yumunio/settings/variables/actions)と[Secrets](https://github.com/KuronekoServer/Yumunio/settings/secrets/actions)へ以下を設定します。秘密値はGitHubのSecret欄へ直接入力し、コード・Issue・チャットには貼り付けません。

| 種類 | 名前 | 設定する値 |
| --- | --- | --- |
| Variable | `DOCKERHUB_IMAGE` | `kuronekoserver/yumunio` |
| Variable | `DOCKERHUB_USERNAME` | Docker Hubで公開できるアカウント名。組織名とは異なる場合があります |
| Secret | `DOCKERHUB_TOKEN` | Docker Hubへの公開用の接続情報 |

`DOCKERHUB_IMAGE` が未設定の間はDocker Hubのジョブをスキップし、GHCRへの公開を継続します。有効化後に接続情報が不足・無効なら、公開済みとは報告せずジョブを失敗させます。フォークで配布する場合は、自分が管理する公開先と接続情報を設定してください。

## 公開を確認する

[Publish container](../../.github/workflows/container.yaml)は、`master` の `latest` と `v*` タグのバージョンを配布します。Docker Hubのジョブは、両アーキテクチャのビルド・起動テストとGHCRへの公開が成功したあとに実行します。

1. `build`、`manifest`、`dockerhub` の結果を確認します。
2. Docker HubのPublicリポジトリに対象のタグがあり、linux/amd64とlinux/arm64の両方を含むことを確認します。
3. 自動検証は、保存済みの接続情報を参照しない別のDocker設定でマニフェストを取得します。Publicでない場合や片方しかない場合は失敗します。
4. 実際の公開版から `docker pull kuronekoserver/yumunio:<tag>` と新規起動を行い、Web初期設定を完了できることを確認します。

Publicへの公開と初回の動作確認が終わるまでは、利用者向けの案内から「初回公開後」の条件を取り除かないでください。ワークフローの設定、ローカルの模擬テスト、実際の配布は別の確認です。

Docker Hubの説明欄には、[プロジェクト](https://github.com/KuronekoServer/Yumunio)、[Docker導入ガイド](../hosting/docker.md)、データの永続化、対応アーキテクチャ、MITライセンスを記載します。[公式の複数レジストリ公開](https://docs.docker.com/build/ci/github-actions/push-multi-registries/)も参照できます。
