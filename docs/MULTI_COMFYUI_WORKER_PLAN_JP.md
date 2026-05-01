# 複数 ComfyUI / Worker 分離運用 調査メモ

作成日: 2026-04-30

## 目的

MV Studio Production で、複数の ComfyUI サーバーと Worker Agent を起動し、画像生成と動画生成を別系統に分離して運用するための調査結果と実装計画をまとめる。

現時点では実装は行わず、調査・設計メモとして残す。

## 現在の構成

### MV Studio Production

- プロジェクト: `/home/animede/mv_studio`
- Production FastAPI: `/home/animede/mv_studio/app_production.py`
- UI:
  - `/home/animede/mv_studio/static/music_video_studio.html`
  - `/home/animede/mv_studio/static/js/music_video_studio.js`
  - `/home/animede/mv_studio/static/css/music_video_studio.css`
- 起動スクリプト: `/home/animede/mv_studio/start_production.sh`

### ComfyUI / Worker Agent

- ComfyUI root: `/home/animede/ComfyUI`
- Worker Agent: `/home/animede/ComfyUI/api_server/worker_agent`
- API Server / Coordinator 候補: `/home/animede/ComfyUI/api_server/comfyui_api_server_v2.py`

## 調査結果

### 1. MV Studio 側は現在、単一 ComfyUI 直結

`app_production.py` は現在、単一の `COMFYUI_SERVER` のみを使う。

- `COMFYUI_SERVER = os.environ.get("COMFYUI_SERVER", "127.0.0.1:8188").strip()`
- `_queue_prompt_to_comfyui()` は `http://{COMFYUI_SERVER}/prompt` に送信
- `_fetch_history()` は `http://{COMFYUI_SERVER}/history/{prompt_id}` を参照
- `_interrupt_comfyui()` も同じ `COMFYUI_SERVER` に `/interrupt`

つまり、現時点では MV Studio 側に「画像用 ComfyUI」「動画用 ComfyUI」のルーティングはない。

### 2. Worker Agent は複数起動しやすい構造

Worker Agent は環境変数で以下を切り替え可能。

- `WORKER_HOST`
- `WORKER_PORT`
- `COMFYUI_URL`
- `WORKER_TOKEN`
- `COMFY_ENV_PATH`

そのため、起動設計上は以下のような構成が可能。

| 役割 | ComfyUI | Worker |
|---|---:|---:|
| 画像生成用 | `127.0.0.1:8188` | `127.0.0.1:9001` |
| 動画生成用 | `127.0.0.1:8189` | `127.0.0.1:9002` |

ただし注意点として、Worker Agent の `/worker/v1/generate` は `WorkflowRequest.server` をそのまま `Job.server` に渡している。

`WorkflowRequest.server` の既定値は `127.0.0.1:8188` なので、`COMFYUI_URL=http://127.0.0.1:8189` で動画 Worker を起動しても、生成先が `8188` のままになる可能性がある。

したがって、実装時には Worker Agent 側で `COMFYUI_URL` を実際の `Job.server` に反映する修正が必要。

### 3. API Server には分散実行の土台がある

`comfyui_api_server_v2.py` には以下の分散実行用設定がある。

- `ENABLE_DISTRIBUTED`
- `WORKER_URL`
- `WORKER_TOKEN`
- `JOB_WORKER_MAP`
- `SESSION_WORKER_MAP`

また、`ENABLE_DISTRIBUTED=1` の場合、`/api/v1/generate` は Worker Agent に処理を委譲する。

ただし現状は基本的に単一 `WORKER_URL` 前提であり、画像用 Worker と動画用 Worker を workflow 種別で選ぶ処理は未実装。

### 4. ComfyUI 本体は複数起動可能

ComfyUI 本体には以下の起動オプションがある。

- `--listen`
- `--port`
- `--input-directory`
- `--output-directory`
- `--temp-directory`
- `--base-directory`
- `--cuda-device`
- `--disable-auto-launch`

そのため、ポート違いで 2 インスタンス起動できる。

確認した GPU 構成:

- GPU: NVIDIA RTX PRO 6000 Blackwell Workstation Edition
- VRAM: 約 98GB
- GPU 数: 1

1 GPU 構成のため、画像生成と動画生成を完全並列にすると VRAM 競合が起きる可能性がある。初期運用では各 Worker の同時実行数を `1` に抑えるのが安全。

## 推奨アーキテクチャ

推奨構成は以下。

```text
MV Studio Production
        |
        | 生成種別でルーティング
        v
ComfyUI API Server / Coordinator
        |
        +--> Image Worker :9001 --> Image ComfyUI :8188
        |
        +--> Video Worker :9002 --> Video ComfyUI :8189
```

この構成の利点:

- MV Studio 本体に Worker 管理を持たせすぎない
- 既存の Worker Agent / API Server の分散実行基盤を活用できる
- `JOB_WORKER_MAP` により、ステータス・中断・ダウンロード先を追跡しやすい
- 将来、音声生成 Worker や複数 GPU / 別マシン Worker へ拡張しやすい

## 実装方針

### Phase 1: 起動構成の確立

2 系統の ComfyUI と Worker を起動できる構成を用意する。

| 用途 | ComfyUI | Worker |
|---|---:|---:|
| 画像生成 | `8188` | `9001` |
| 動画生成 | `8189` | `9002` |

想定環境変数:

| 変数 | 画像 Worker | 動画 Worker |
|---|---|---|
| `WORKER_PORT` | `9001` | `9002` |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | `http://127.0.0.1:8189` |
| `WORKER_ROLE` | `image` | `video` |
| `WORKER_CAPABILITIES` | `image,t2i,i2i,character,scene-image` | `video,i2v,flf,scene-video` |

### Phase 2: Worker Agent の実行先修正

Worker Agent 側で、`COMFYUI_URL` を実際の生成先として使うようにする。

必要な対応:

- `load_config().comfyui_url` を読み込む
- `/worker/v1/generate` で作成した `req.server` または `Job.server` を `COMFYUI_URL` 由来の `host:port` に上書きする
- `http://127.0.0.1:8189` を `127.0.0.1:8189` 形式に正規化する
- `/worker/v1/info` に以下を追加する
  - `role`
  - `capabilities`
  - `comfyui_url`
  - `max_workers`

### Phase 3: Coordinator に複数 Worker ルーティングを追加

現在の単一 `WORKER_URL` から、複数 Worker 定義へ拡張する。

候補環境変数:

```text
WORKER_URLS=image=http://127.0.0.1:9001,video=http://127.0.0.1:9002
DEFAULT_WORKER_ROLE=image
```

または JSON 形式:

```text
WORKER_ROUTES={"image":"http://127.0.0.1:9001","video":"http://127.0.0.1:9002"}
```

追加する処理:

- `WorkerRoute` 相当の構造
- `_select_worker_for_request(request)`
- `_classify_workflow_lane(workflow, parameters)`

既存の `JOB_WORKER_MAP` は活かせる。

ただし `SESSION_WORKER_MAP` は現在 `client_session_id -> worker` のため、同一セッション内で画像生成と動画生成が同じ Worker に固定される恐れがある。

画像・動画分離を正しく行うには、以下のように lane も含めたキーにするのが安全。

```text
(session_id, lane) -> worker
```

例:

```text
("session-A", "image") -> image worker
("session-A", "video") -> video worker
```

### Phase 4: Workflow 分類ルール

画像生成レーン:

- `qwen_*`
- `qwen_i2i_*`
- `flux_*`
- `flux2_*`
- `z_image_*`
- `character_sheet`
- `character_image`
- `scene-image`
- 静止画編集系

動画生成レーン:

- `wan22_*`
- `ltx*`
- `i2v`
- `flf`
- `scene-video`
- `video_concat`
- `video_audio_merge`
- `image_audio_slideshow`
- `extract_last_frame`

音声生成:

- `ace_step_*`
- `music/generate`

音声は当面 `default` または `image` 側に残し、必要になったら `audio` Worker を追加する方針が安全。

### Phase 5: ファイル共有方針

画像生成結果を動画生成の入力に使うため、画像 Worker と動画 Worker の間でファイルが参照できる必要がある。

短期推奨:

- 同じ `/home/animede/ComfyUI/input`
- 同じ `/home/animede/ComfyUI/output`
- 同じ `/home/animede/ComfyUI/temp`

を共有する。

メリット:

- 画像 Worker の出力を動画 Worker がすぐ参照できる
- Worker Agent の現在の固定パス実装と相性がよい
- 実装量が少ない

デメリット:

- 出力ファイル名衝突リスク
- cleanup の影響範囲が広い
- 将来、別マシン Worker に拡張しにくい

対策:

- session prefix を必ず付ける
- job id prefix を出力名に含める
- cleanup 対象を session 単位で制御する

長期推奨:

- Coordinator artifact store に生成物を取り込む
- 必要な Worker へ artifact を配布する
- MV Studio は Coordinator の download URL を参照する

## MV Studio 側の実装候補

### 候補 A: MV Studio から直接 ComfyUI を振り分ける

追加設定例:

```text
COMFYUI_IMAGE_SERVER=127.0.0.1:8188
COMFYUI_VIDEO_SERVER=127.0.0.1:8189
COMFYUI_AUDIO_SERVER=127.0.0.1:8188
```

必要な変更:

- `_queue_prompt_to_comfyui(workflow, lane)`
- `_fetch_history(prompt_id, lane)`
- `prompt_id -> server` の管理
- scene image は image server
- scene video は video server

メリット:

- 実装が小さい
- MV Studio だけで完結
- 早く動作検証できる

デメリット:

- Worker Agent を活かせない
- 将来の複数 Worker / 別マシン化に弱い
- ファイル転送やダウンロード管理を MV Studio が持つことになる

### 候補 B: Worker / Coordinator 経由に寄せる

推奨案。

必要な変更:

- Worker Agent が `COMFYUI_URL` を実行先として使う
- Coordinator が `image` / `video` Worker を選択する
- MV Studio は Coordinator に生成要求を送る、または MV Studio 内に Coordinator 相当のルーティングを持つ

メリット:

- 今後の拡張性が高い
- Worker の増設に強い
- 生成・中断・ダウンロードの所有者管理がしやすい

デメリット:

- 候補 A より実装量が多い
- MV Studio の既存 direct ComfyUI 実装との接続整理が必要
- Worker 間ファイル共有設計が必要

## 推奨実装順

1. `8188=image`、`8189=video` で ComfyUI を 2 起動する
2. `9001=image worker`、`9002=video worker` を起動する
3. Worker Agent で `COMFYUI_URL` を実行先に反映する修正を入れる
4. Coordinator に `WORKER_URLS` と workflow 分類ルーティングを追加する
5. MV Studio の生成処理を段階的に Coordinator / Worker 経由へ寄せる
6. 初期段階では同じ `input/` / `output/` を共有し、後で artifact store 方式へ移行する

## 運用上の注意

### 単一 GPU の同時実行数

GPU は 1 枚構成のため、初期値は以下を推奨。

| Worker | max workers |
|---|---:|
| image worker | `1` |
| video worker | `1` |

動画生成中に画像生成を同時実行すると VRAM が急増する可能性がある。

### モデルロード

ComfyUI を 2 プロセス起動すると、同じモデルでも別々に VRAM に載る可能性がある。

対策:

- 画像用と動画用で使うモデルを明確に分ける
- 動画生成中は画像の高解像度生成を避ける
- 必要なら `lowvram` / `normalvram` 起動を検討する

### 中断処理

中断処理は、生成ジョブを所有している Worker / ComfyUI へ送る必要がある。

Coordinator 経由なら `JOB_WORKER_MAP` を活用できる。

MV Studio 直接ルーティング方式の場合は、`prompt_id` と `server` の対応表を MV Studio 側で持つ必要がある。

### ダウンロード処理

Worker 分離後は、生成物がどちらの Worker / ComfyUI にあるかを追跡する必要がある。

短期:

- 同じ `output/` を共有する

長期:

- Coordinator artifact store に取り込む
- MV Studio は Coordinator の download URL を使う

## 検証チェックリスト

実装後に確認すること。

1. `127.0.0.1:8188/system_stats` が返る
2. `127.0.0.1:8189/system_stats` が返る
3. `127.0.0.1:9001/health` が image Worker として返る
4. `127.0.0.1:9002/health` が video Worker として返る
5. Qwen 系画像生成が `8188` にだけ投入される
6. Wan / LTX 系動画生成が `8189` にだけ投入される
7. 画像生成結果を動画生成入力として参照できる
8. ジョブ状態取得が正しい Worker に問い合わせられる
9. interrupt / cancel が正しい Worker / ComfyUI に届く
10. ダウンロード URL が壊れない
11. ブラウザ更新後も過去ジョブ・生成物参照が破綻しない

## 結論

最も安全な方針は、Worker / Coordinator 経由で画像生成と動画生成を分離する構成。

推奨構成:

- Image ComfyUI: `127.0.0.1:8188`
- Video ComfyUI: `127.0.0.1:8189`
- Image Worker: `127.0.0.1:9001`
- Video Worker: `127.0.0.1:9002`

実装上の最重要ポイント:

1. Worker Agent の `COMFYUI_URL` を実際の生成先として反映する
2. Coordinator に `image` / `video` の Worker ルーティングを追加する
3. `SESSION_WORKER_MAP` を lane 対応にする
4. 生成物共有は、短期は shared `input/output`、長期は artifact store へ移行する
