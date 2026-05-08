# Music Video Studio

Version: v1.0.0  
License: [MIT](./LICENSE)  
Language: 日本語 | [English](./README_EN.md)

**Music Video Studio** は、ComfyUI をバックエンドにして、キャラクター設計・シナリオ作成・音楽生成・シーン画像生成・シーン動画生成・完成MV書き出しを 1 つの制作キャンバスで進めるための MV 制作アプリです。

現在の既定UIは **Production 版 Music Video Studio** です。  
旧 `Generative Media Place` / `Simple Video` 系UIは互換用として残しています。

中断後に再開する場合は、[docs/HANDOFF_2026-05-03_JP.md](docs/HANDOFF_2026-05-03_JP.md) を先に確認してください。

---

## 概要

このアプリは、MV 制作を次の STEP に分けて扱います。

1. キャラクタ作成
2. シナリオ・世界観作成
3. 音楽作成
4. シーン画像作成
5. シーン動画作成
6. 完成MV書き出し

制作タイプや制作実行プランを選び、各 STEP の成果物を次工程へ受け渡しながら MV を組み立てます。

---

## 主な特徴

- **制作キャンバス**
  - キャンバス名、選択プリセット、制作実行プラン、選択STEP、保存状態を管理
- **制作タイプ選択**
  - キャラ主導MV
  - 歌詞重視MV
  - 既存素材編集MV
- **制作実行プラン選択**
  - キャラ一貫性重視
  - シーン単位調整
  - FLF / I2V / 混在トランジション系プラン
- **STEP制作・編集エリア**
  - 選択STEPごとの入力、生成、確認、再生成を行う作業領域
- **キャラクター制作**
  - 参照画像スロット
  - キャラクター画像生成
  - キャラシート生成
  - 動画比率への非AI画像フィット処理
- **シナリオ・世界観作成**
  - OpenAI互換APIによるシナリオ生成
  - キャラクター文脈・世界観メモの反映
- **音楽作成**
  - 歌詞・楽曲プラン生成
  - ACE-Step API または ComfyUI workflow による音楽生成
  - 外部音源インポート、トリミング
- **シーン画像作成**
  - シーンプロンプト生成
  - シーン尺・遷移提案
  - 全シーン画像一括生成
- **シーン動画作成**
  - I2V / FLF / LTX 系 workflow
  - シーン単位生成
  - 全シーン動画一括生成
- **完成MV書き出し**
  - シーンクリップ結合
  - 音楽合成
  - 結合から完成MVまでの自動制作ボタン
  - 専用ページ `MV Library` での生成済みMV一覧表示
  - UIからの過去MVアップロード登録
  - 任意フォルダからのMVインポート
  - タイトル / メモ付き管理
- **状態保存**
  - localStorage とサーバー側 session state に保存

---

## 現在の注意点

- 「自動制作」「STEP作成」「編集」は UI 上の制作モードとして存在しますが、現時点では主に表示・導線・説明の切り替えです。
- 完全な end-to-end 自動制作モードは段階的に整備中です。
- 生成処理は基本的に各 STEP のボタン操作で実行します。
- ComfyUI は既定で `127.0.0.1:8188` を使用します。
- 複数 ComfyUI / Worker 分離運用は設計メモ段階です。詳細は [docs/MULTI_COMFYUI_WORKER_PLAN_JP.md](docs/MULTI_COMFYUI_WORKER_PLAN_JP.md) を参照してください。

---

## ディレクトリ構成

主要ファイル:

```text
mv_studio/
├── app_production.py                 # Production版 FastAPI アプリ
├── start_production.sh               # Production版 起動スクリプト
├── static/
│   ├── music_video_studio.html       # Production版 UI
│   ├── mv_library.html               # 生成済みMV一覧の専用画面
│   ├── js/music_video_studio.js      # Production版 フロントエンドロジック
│   ├── js/mv_library.js              # MV Library ロジック
│   └── css/music_video_studio.css    # Production版 スタイル
├── lt/                               # 発表資料・図版一式（git 管理外）
├── workflows/                        # ComfyUI API workflow JSON
├── docs/                             # 技術メモ・利用ガイド・設計資料
├── data/                             # 状態保存・参照画像・セッションデータ（git 管理外）
├── input/                            # 入力ファイル（git 管理外）
├── output/                           # 出力ファイル（git 管理外）
└── temp/                             # 一時ファイル（git 管理外）
```

旧互換UI:

```text
app.py
start.sh
static/index.html
static/js/simple_video.js
```

プレゼン資料:

- 本番用の発表資料・図版・Mermaid ソースは [lt/README.md](lt/README.md) を参照してください
- `lt/` はローカル作業用フォルダーとして `.gitignore` でフォルダーごと除外しています

---

## 要件

- Python 3.10+
- ComfyUI
- ComfyUI API workflow を実行できるモデル / custom nodes
- ffmpeg
- ブラウザ

任意:

- OpenAI互換API
  - シナリオ生成
  - 歌詞・楽曲プラン生成
  - プロンプト生成
  - 翻訳 / VLM解析
- ACE-Step API Server
  - 外部 API 経由の音楽生成に使用

---

## セットアップ

### 1. ComfyUI を起動

例:

```bash
cd /home/animede/ComfyUI
source /home/animede/comfy-env/bin/activate
python main.py --listen 127.0.0.1 --port 8188
```

ブラウザまたは curl で確認:

```bash
curl http://127.0.0.1:8188/system_stats
```

### 2. アプリ依存関係をインストール

```bash
cd /home/animede/mv_studio
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 3. Production版を起動

```bash
bash start_production.sh
```

既定URL:

```text
http://127.0.0.1:8091/
```

---

## 起動オプション

`start_production.sh` は以下に対応しています。

```bash
bash start_production.sh --host 127.0.0.1 --port 8091
bash start_production.sh --openai-base-url http://127.0.0.1:11434/v1
bash start_production.sh --openai-api-key sk-xxxx
bash start_production.sh --vlm-base-url http://127.0.0.1:11434/v1
bash start_production.sh --vlm-model gemma-3-27b-it
bash start_production.sh --ace-step-url http://127.0.0.1:8001
bash start_production.sh --no-reload
```

主な環境変数:

| 変数 | 用途 | 既定値 |
|---|---|---|
| `MV_PRODUCTION_HOST` | Production版 bind host | `127.0.0.1` |
| `MV_PRODUCTION_PORT` | Production版 port | `8091` |
| `COMFYUI_SERVER` | ComfyUI server | `127.0.0.1:8188` |
| `COMFYUI_DIR` | ComfyUI root 自動検出の補助 | 自動検出 |
| `COMFYUI_INPUT_DIR` | ComfyUI input dir | `ComfyUI/input` |
| `COMFYUI_OUTPUT_DIR` | ComfyUI output dir | `ComfyUI/output` |
| `OPENAI_BASE_URL` | OpenAI互換API endpoint | 任意 |
| `OPENAI_API_KEY` | OpenAI互換API key | 任意 |
| `VLM_BASE_URL` | VLM endpoint | `OPENAI_BASE_URL` 相当 |
| `VLM_API_KEY` | VLM API key | 任意 |
| `VLM_MODEL` | VLM model | `gemma-3-27b-it` |
| `ACE_STEP_API_URL` | ACE-Step API Server | 任意 |

---

## 基本的な使い方

### 1. 制作タイプを選ぶ

画面左の制作キャンバスで「制作タイプ」を選びます。

- キャラ主導MV
- 歌詞重視MV
- 既存素材編集MV

### 2. 制作実行プランを選ぶ

制作フロープラン選択で、画像生成・動画生成の進め方を選びます。

例:

- キャラ一貫性を重視した標準動画制作
- 品質と柔軟性を両立させた高度な動画制作
- シーン単位で調整しやすい動画制作
- 高速な連続長尺動画制作

### 3. STEPを選ぶ

フロー上の STEP カードをクリックすると、右側の STEP制作・編集エリアが切り替わります。

### 4. 各STEPを実行

代表的な流れ:

1. キャラクタ作成で参照画像・キャラ画像・キャラシートを準備
2. シナリオ・世界観作成で構成を作成
3. 音楽作成で歌詞・楽曲・音源を作成
4. シーン画像作成でシーンプロンプトと画像を作成
5. シーン動画作成で各シーンを動画化
6. 完成MVでクリップ結合と音楽合成を実行

### 生成済みMV一覧 / 過去MV管理

完成MV STEP から、生成済みMV一覧の専用ページ `MV Library` を開けます。

できること:

- `output/movie` に保存された最近のMV一覧表示
- 過去に作成したMVファイルをブラウザUIからアップロード登録
- サーバー上の任意フォルダからMVを一括インポート
- 各MVにタイトル / メモを付けて管理

主な画面:

- `GET /mv_library.html`
- [static/mv_library.html](static/mv_library.html)
- [static/js/mv_library.js](static/js/mv_library.js)

補足:

- 生成済みMV一覧は `MV Library` 専用画面で表示します
- 完成MV STEP 側は一覧への導線と件数確認のみを持ちます
- インポート / アップロードされたMVも `output/movie` 配下へ取り込みます

### キャラクタを使わない MV の作り方

この UI は「キャラクタ作成」という名前ですが、実際には **景色・建物・小物・乗り物・抽象オブジェクト** などを主役にした MV にも使えます。

おすすめの進め方:

1. キャラクタ作成 STEP で、人物用素材を使わない場合は `キャラ合成画像` と `キャラシート` を空にしておく
2. 主役にしたい景色や物体を次のどちらかで用意する
  - `ref1` に直接アップロードする
  - `テキストから新規作成` で画像を作り、必要なら `ref1に使う` で `ref1` へ移す
3. `テキストから新規作成` の出力を `ref1` に移した場合は、`キャラ合成画像` が優先参照にならないよう `クリア` しておく
4. 必要に応じて `ref2` は別アングルや補助資料、`ref3` は背景・スタイル参照として使う
5. シナリオ・世界観作成 / シーン画像作成 では、「誰が」ではなく「何が主役か」「どの場所を見せたいか」を明確に書く
6. シーン画像を生成し、意図に合う絵になったらシーン動画作成へ進む

ポイント:

- シーン画像生成では、参照画像は `キャラ合成画像` → `キャラシート` → `ref1` → `ref2` → `ref3` の順で使われます
- そのため、**景色や物体を主役にしたい場合は `キャラ合成画像` / `キャラシート` を残さない** 方が意図どおりになりやすいです
- 風景MV、プロダクトMV、コンセプト映像、抽象映像のような用途でも同じ流れで制作できます

---

## Production API

`app_production.py` が提供する主な API:

| API | 内容 |
|---|---|
| `GET /` | Production UI |
| `GET /music_video_studio.html` | Production UI |
| `GET /mv_library.html` | 生成済みMV一覧の専用画面 |
| `GET /api/v1/production/config` | プリセット・モード設定 |
| `GET /api/v1/production/state` | 状態取得 |
| `POST /api/v1/production/state` | 状態保存 |
| `POST /api/v1/production/story/generate` | シナリオ生成 |
| `POST /api/v1/production/music/plan` | 歌詞・楽曲プラン生成 |
| `POST /api/v1/production/music/generate` | 音楽生成 |
| `POST /api/v1/production/music/import` | 音源インポート |
| `POST /api/v1/production/music/trim` | 音源トリミング |
| `POST /api/v1/production/scene-plan/generate` | シーン尺・遷移提案 |
| `POST /api/v1/production/scene-image/prompts` | シーン画像プロンプト生成 |
| `POST /api/v1/production/scene-image/generate` | シーン画像生成 |
| `POST /api/v1/production/scene-video/generate` | シーン動画生成 |
| `POST /api/v1/production/final-mv/render` | クリップ結合 / 音楽合成 |
| `GET /api/v1/production/final-mv/list` | MV Library 用の一覧取得 |
| `POST /api/v1/production/final-mv/library/upload` | UIからMVをアップロード登録 |
| `POST /api/v1/production/final-mv/library/import-folder` | 任意フォルダからMVを一括インポート |
| `POST /api/v1/production/final-mv/library/metadata` | タイトル / メモ保存 |
| `POST /api/v1/production/character-image` | キャラクター画像生成 |
| `POST /api/v1/production/character-image/fit-video` | 動画比率への画像フィット |
| `POST /api/v1/production/character-sheet` | キャラシート生成 |
| `POST /api/v1/production/cancel` | 実行中処理のキャンセル要求 |

---

## Workflow / モデル

ComfyUI workflow JSON は [workflows](workflows) にあります。

主に使用する系統:

- Qwen Image / Qwen Image Edit
- Flux / Flux Kontext / Flux2 edit
- Wan2.2 I2V / FLF / T2V
- LTX Video
- ACE-Step 1.5 T2A
- RMBG / remove background
- video concat / audio merge 系 utility

モデル名・custom node・VRAM 目安は workflow の内容と ComfyUI 環境に依存します。  
詳細は以下を参照してください。

- [docs/TECHNICAL_JP.md](docs/TECHNICAL_JP.md)
- [docs/PIPELINE_CHAR_EDIT_I2I_FLF_JP.md](docs/PIPELINE_CHAR_EDIT_I2I_FLF_JP.md)
- [docs/PIPELINE_CHAR_EDIT_I2I_MIXED_JP.md](docs/PIPELINE_CHAR_EDIT_I2I_MIXED_JP.md)
- [docs/MV_STUDIO_PRESET_MAPPING_JP.md](docs/MV_STUDIO_PRESET_MAPPING_JP.md)

---

## 状態保存

Production UI は以下に状態を保存します。

| 保存先 | 内容 |
|---|---|
| localStorage `mvStudioProductionState` | ブラウザ側のUI状態 |
| localStorage `comfyui_api_client_session_id` | セッションID |
| `data/production_state.json` | サーバー側共通状態 |
| `data/production_sessions/` | セッション別状態 |
| `data/ref_images/` | 参照画像 |
| `data/mv_library.json` | MV Library のタイトル / メモ / 取込元メタデータ |

`data/`, `input/`, `output/`, `temp/`, `llm/` は `.gitignore` で除外しています。

---

## 旧UIを使う場合

旧 `Generative Media Place` / `Simple Video` UI は互換用として残しています。

```bash
bash start.sh
```

旧UIの主なファイル:

- [app.py](app.py)
- [static/index.html](static/index.html)
- [static/js/simple_video.js](static/js/simple_video.js)

---

## 開発メモ

### Production UI 関連

- [docs/MUSIC_VIDEO_STUDIO_JP.md](docs/MUSIC_VIDEO_STUDIO_JP.md)
- [docs/CHARACTER_STEP_IMPLEMENTATION_PLAN_JP.md](docs/CHARACTER_STEP_IMPLEMENTATION_PLAN_JP.md)
- [docs/MV_STUDIO_PLAN_JP.md](docs/MV_STUDIO_PLAN_JP.md)
- [docs/MV_STUDIO_PRESET_MAPPING_JP.md](docs/MV_STUDIO_PRESET_MAPPING_JP.md)

### ComfyUI / Worker 分離計画

- [docs/MULTI_COMFYUI_WORKER_PLAN_JP.md](docs/MULTI_COMFYUI_WORKER_PLAN_JP.md)

### ヘルプ / チュートリアル

- [docs/HELP_JP.md](docs/HELP_JP.md)
- [docs/TUTORIAL_JP.md](docs/TUTORIAL_JP.md)
- [docs/USAGE_JP.md](docs/USAGE_JP.md)

---

## ライセンス

[MIT License](./LICENSE)
