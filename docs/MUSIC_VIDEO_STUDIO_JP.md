# Music Video Studio 変更ドキュメント

最終更新: 2026-05-05

## 概要

`Music Video Studio` は、従来の `Generative Media Place` / `Simple Video` 系UIとは別に導入した、**起動直後の体験を刷新するための新GUI** です。

本ドキュメントは、今回の変更作業について以下を整理するためのものです。

- なぜ新GUIを追加したのか
- 何を変更したのか
- どのファイルが新GUIに対応しているのか
- どう起動するのか
- 旧GUIとの関係はどうなっているのか

## 変更の目的

従来UIは、画像生成・動画生成・音楽生成・補助機能が1画面に集約されており、既存ユーザーには強力である一方、起動直後の導線としては次の課題がありました。

- 最初に何から始めればよいか分かりにくい
- 「新規制作」「途中STEPからの制作」「既存素材の編集」の違いが見えにくい
- プリセット・STEP・成果物の関係が画面構造に出ていない
- 制作キャンバスという概念が視覚的に弱い

このため、新GUIでは **起動直後に制作の入口を明確にする** ことを主目的として、`production` を実装しました。

## 変更の要点

### 1. 既定GUIを新UIに変更

今後の既定起動先は `Music Video Studio` とします。

- 新GUIのエントリ: [app_production.py](../app_production.py)
- 新GUIのHTML: [static/music_video_studio.html](../static/music_video_studio.html)
- 生成済みMV一覧HTML: [static/mv_library.html](../static/mv_library.html)
- 新GUIのJS: [static/js/music_video_studio.js](../static/js/music_video_studio.js)
- 生成済みMV一覧JS: [static/js/mv_library.js](../static/js/mv_library.js)
- 新GUIのCSS: [static/css/music_video_studio.css](../static/css/music_video_studio.css)
- 新GUIの起動スクリプト: [start_production.sh](../start_production.sh)

### 2. 新しい起動コマンドを追加

関連計画:

- キャラクタ作成STEPの移植計画: [docs/CHARACTER_STEP_IMPLEMENTATION_PLAN_JP.md](CHARACTER_STEP_IMPLEMENTATION_PLAN_JP.md)

新GUIは以下で起動します。

```bash
bash start_production.sh
```

または仮想環境を明示して起動します。

```bash
source .venv/bin/activate
python -m uvicorn app_production:app --host 127.0.0.1 --port 8091 --reload
```

既定ポートは `8091` です。

### 3. 旧GUIは互換用として維持

旧GUIは削除していません。既存の制作機能やAPI中心の導線は引き続き利用できます。

- 旧GUIのエントリ: [app.py](../app.py)
- 旧GUIのHTML: [static/index.html](../static/index.html)
- 旧GUIの主要ロジック: [static/js/simple_video.js](../static/js/simple_video.js)
- 旧GUI起動: [start.sh](../start.sh)
- 旧サーバーモード起動: [start_server.sh](../start_server.sh)

## 新GUIの画面構成

新GUIは、起動直後に「どの制作の進め方で入るか」を明確にする構成です。

### 上段左: 制作キャンバス

- 前回の状態を維持
- キャンバス名の編集
- 新規作成 / 復元
- 現在のプリセット・モード・STEPの要約表示

### 上段右: プリセット選択

- 制作プリセットの選択
- 推奨モードの提示
- フローの全体概要表示

### 下段左: STEPナビ

- 各STEPの一覧
- 現在どの工程を編集するかを選択

### 下段右: STEP制作・編集エリア

- 選択したSTEPの目的
- サブフロー
- 設定項目
- 出力物
- 次工程への受け渡し内容

### 生成済みMV一覧: 専用ブラウザ画面

- 完成MV STEP から専用画面へ遷移
- `output/movie` の最近のMV一覧を表示
- UIからMVアップロード登録
- 任意フォルダからMVインポート
- タイトル / メモ付き管理

## モード設計

新GUIでは、制作の入り口を次の3モードで整理しています。

### `new`

最初から最後まで新しいMVを作るモードです。

### `step`

特定STEPから着手し、必要な範囲だけ順番に進めるモードです。

### `edit`

既存キャンバスや完成物をベースに、一部だけ差し替えるモードです。

## 現在実装しているプリセット

[app_production.py](../app_production.py) の `PRESET_CATALOG` で定義しています。

既存の `simple_video` プリセット群との対応は [docs/MV_STUDIO_PRESET_MAPPING_JP.md](MV_STUDIO_PRESET_MAPPING_JP.md) を参照してください。

### 1. キャラ主導MV

- キャラクタ作成
- シナリオ・世界観作成
- 音楽作成
- シーン画像作成
- シーン動画作成
- 完成MV

### 2. 歌詞重視MV

- 歌詞・構成設計
- キャラ・モチーフ整理
- 歌詞と表現のシーン画像
- 歌詞同期動画
- MV統合

### 3. 既存素材編集MV

- 既存素材読込
- 画像差し替え
- 動画差し替え
- 完成MV更新

## 状態保存の仕様

新GUIはローカル保存とサーバー保存の両方を持っています。

### ローカル保存

- `localStorage`
- キー: `mvStudioProductionState`

### セッションID

- `localStorage`
- キー: `comfyui_api_client_session_id`

### サーバー保存先

- 共通状態: [data/production_state.json](../data/production_state.json)
- セッション別状態: [data/production_sessions](../data/production_sessions)
- MVライブラリ管理情報: [data/mv_library.json](../data/mv_library.json)

## 新GUIのAPI

[app_production.py](../app_production.py) で提供しています。

### 画面配信

- `GET /`
- `GET /music_video_studio.html`
- `GET /mv_library.html`

### 設定取得

- `GET /api/v1/production/config`

### 状態取得・保存

- `GET /api/v1/production/state`
- `POST /api/v1/production/state`

### 生成済みMV一覧 / ライブラリ管理

- `GET /api/v1/production/final-mv/list`
- `POST /api/v1/production/final-mv/library/upload`
- `POST /api/v1/production/final-mv/library/import-folder`
- `POST /api/v1/production/final-mv/library/metadata`

### プリセット取得

- `GET /api/v1/production/preset/{preset_id}`

## 起動方法

### 推奨: 仮想環境 + 新GUI

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
bash start_production.sh
```

ブラウザ:

- `http://127.0.0.1:8091/`

### 旧GUIを使う場合

```bash
bash start.sh
```

## 旧GUIとの関係

現時点では、新GUIは **制作の入口を整理した production** です。
一方で、従来の詳細な生成UI・既存APIフローは旧GUI側に残っています。

つまり、現状は次の住み分けです。

- **新GUI (`Music Video Studio`)**: 起動直後の導線、プリセット選択、制作入口の整理
- **旧GUI (`Generative Media Place` / `Simple Video`)**: 既存の詳細生成操作、従来APIフロー

## 今回の変更で更新対象になった主なファイル

### 新規 / 新GUI系

- [app_production.py](../app_production.py)
- [start_production.sh](../start_production.sh)
- [static/music_video_studio.html](../static/music_video_studio.html)
- [static/mv_library.html](../static/mv_library.html)
- [static/js/music_video_studio.js](../static/js/music_video_studio.js)
- [static/js/mv_library.js](../static/js/mv_library.js)
- [static/css/music_video_studio.css](../static/css/music_video_studio.css)

### ドキュメント / 起動方針更新

- [README.md](../README.md)
- [README_EN.md](../README_EN.md)

### 互換として維持する旧系統

- [app.py](../app.py)
- [app_server.py](../app_server.py)
- [start.sh](../start.sh)
- [start_server.sh](../start_server.sh)
- [static/index.html](../static/index.html)
- [static/js/simple_video.js](../static/js/simple_video.js)

## 制約と現状

現時点での新GUIは、完成済みのフル制作画面ではなく、**新しい制作入口の試作実装** です。

そのため、以下は今後の整理対象です。

- 新GUIから旧GUIの個別機能へどう接続するか
- 新GUI上でどこまで生成実行を完結させるか
- 旧GUIの機能群をどの単位で新GUIへ再配置するか
- ドキュメント群（USAGE / TUTORIAL / TECHNICAL）を新GUI前提へ揃えるか

## 今後の推奨方針

今後は、以下を標準運用とします。

1. 起動直後は `Music Video Studio` を使う
2. 仮想環境を有効化した状態で起動する
3. ポートは `8091` を既定とする
4. README は新GUIを既定として案内する
5. 旧GUIは互換運用として残しつつ、段階的に役割を縮小する

## 関連ドキュメント

- 変更計画メモ: [MV_STUDIO_PLAN_JP.md](MV_STUDIO_PLAN_JP.md)
- 既定README: [../README.md](../README.md)
- 技術ガイド: [TECHNICAL_JP.md](TECHNICAL_JP.md)
- ユーザーズガイド: [USAGE_JP.md](USAGE_JP.md)

## まとめ

`Music Video Studio` は、単なる名称変更ではなく、**制作の始め方そのものを整理するための新しいGUI導線** です。

今回の変更では、

- 新GUIの追加
- 新GUI専用サーバーの追加
- 新GUI専用起動スクリプトの追加
- 既定ポートの整理
- README の既定案内変更

を行い、今後はこちらを既定フローとして継続していきます。
