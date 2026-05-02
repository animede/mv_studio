# 音楽作成STEPへのカバー / リペイント機能導入計画

## 1. 目的

`mv_studio` の「音楽作成」STEPに、
`/home/animede/gm_song/ace_step_client_pro` で実装済みの以下を取り込む。

- **カバー機能**: 参照音声の構造・声質・スタイルを元に新しい曲を生成
- **リペイント機能**: 既存音声の一部区間だけを再生成

既存フロー

- シナリオ → 音楽 → シーン画像 → シーン動画 → 完成MV

を壊さず、**音楽STEPの派生操作**として自然に追加する。

---

## 2. 参照実装の確認結果

### 2.1 参照元

- UI: `/home/animede/gm_song/ace_step_client_pro/templates/index.html`
- Frontend: `/home/animede/gm_song/ace_step_client_pro/static/app.js`
- Backend: `/home/animede/gm_song/ace_step_client_pro/routers/generate.py`
- ACE-Step multipart client: `/home/animede/gm_song/ace_step_client_pro/services/ace_step_client.py`

### 2.2 参照実装の要点

#### カバー

- UI
  - `cover_audio` ファイル入力
  - `cover_strength` スライダー
  - `🎤 カバー生成` ボタン
- API
  - `POST /api/generate_cover`
  - `multipart/form-data`
  - `src_audio`
  - `task_type = cover`
  - `audio_cover_strength`
- 制約
  - `audio_cover_strength < 1.0` の場合 `guidance_scale = 1.0` を強制

#### リペイント

- UI
  - `repaint_audio` ファイル入力
  - `repainting_start`
  - `repainting_end`
  - `🎨 リペイント生成`
- API
  - `POST /api/generate_repaint`
  - `multipart/form-data`
  - `src_audio`
  - `task_type = repaint`
  - `repainting_start`
  - `repainting_end`

### 2.3 mv_studio 現状

#### Frontend

- 音楽STEP UI: `static/js/music_video_studio.js` の `renderMusicWorkspace()`
- 現在ある操作
  - `🎵 音楽制作`
  - `🧠 歌詞・楽曲プラン作成`
  - `📥 外部音楽を読み込む`
  - `✂️ トリミング`
- 生成済み音声は `state.musicStep.generatedAudio` に集約

#### Backend

- 通常生成
  - `POST /api/v1/production/music/generate`
- 外部音楽取り込み
  - `POST /api/v1/production/music/import`
- トリミング
  - `POST /api/v1/production/music/trim`
- ACE-Step 連携は `_generate_music_audio_via_ace_step_api()` が JSON の `/release_task` を使用
- **multipart upload を使う cover / repaint 系 API は未実装**

---

## 3. 用語整理

今後は UI / 文書 / 実装のすべてで、以下の表現に統一する。

- **カバー** = 参照音声をもとに新生成
- **リペイント** = 既存音声の一部区間だけ再生成

内部実装では ACE-Step API の仕様に合わせて:

- カバー → `task_type=cover`
- リペイント → `task_type=repaint`

とする。

---

## 4. 導入方針

### 4.1 基本方針

音楽STEPに「通常生成 / 外部読込 / カバー / リペイント」の4系統を共存させる。
ただし UI は分離しすぎず、**既存の生成済み音声カードを中心に派生操作として追加**する。

### 4.2 推奨 UX

1. まず通常どおり `音楽制作` または `外部音楽を読み込む`
2. 生成済み音声カードの近くに
   - `🎤 カバー`
   - `🎨 リペイント`
   を配置
3. 実行結果はどちらも `generatedAudio` を更新し、後続STEPはそのまま新しい音声を参照

この形なら、既存の「後続へ渡す音声素材」が常に1本で済む。

---

## 5. 実装計画

### Phase 1: 状態設計

#### 5.1 `state.musicStep` の拡張

追加候補:

- `coverSourceAudio: null`
  - カバー用参照音声メタ情報
- `coverStrength: 0.8`
- `repaintStartSec: 0`
- `repaintEndSec: 0`
- `lastGenerationMode: 'generate' | 'import' | 'cover' | 'repaint'`
- `generationHistory: []`（任意。初期導入では省略可）
- `musicEditPanel: 'none' | 'cover' | 'repaint' | 'trim'`

#### 5.2 保存対象

ローカル保存・セッション保存の対象に含める。
ただしバイナリ本体は持たず、保持するのは以下のみ:

- filename
- originalName
- previewUrl
- durationSec
- backend
- source
- trimStartSec / trimEndSec
- cover / repaint 用パラメータ

#### 5.3 互換性

既存の `generatedAudio` を壊さない。
新規フィールドが無い旧データでも動作するよう、restore 時はデフォルト補完にする。

---

### Phase 2: Backend API 追加

#### 6.1 追加エンドポイント案

`app_production.py` に以下を追加する。

##### 1) カバー生成

- `POST /api/v1/production/music/cover`
- multipart/form-data

受け取り項目:

- `client_session_id`
- `src_audio` (UploadFile)
- `tags`
- `lyrics`
- `language`
- `duration`
- `bpm`
- `timesignature`
- `keyscale`
- `steps`
- `cfg`
- `seed`
- `thinking`
- `audio_cover_strength`

##### 2) リペイント生成

- `POST /api/v1/production/music/repaint`
- multipart/form-data

受け取り項目:

- `client_session_id`
- `src_audio` (UploadFile)
- `repainting_start`
- `repainting_end`
- `tags`
- `lyrics`
- `language`
- `duration`
- `bpm`
- `timesignature`
- `keyscale`
- `steps`
- `cfg`
- `seed`
- `thinking`

#### 6.2 内部ヘルパー追加

既存 `_generate_music_audio_via_ace_step_api()` とは別に、multipart 向けヘルパーを追加する。

候補:

- `_generate_music_cover_via_ace_step_api(...)`
- `_generate_music_repaint_via_ace_step_api(...)`

共通化するなら:

- `_generate_music_audio_via_ace_step_multipart(task_type, src_audio_bytes, ...)`

#### 6.3 共通処理

両APIとも以下を共通化する。

- 入力バリデーション
- `src_audio` 読み込み
- ACE-Step `/release_task` への multipart リクエスト
- `/query_result` ポーリング
- 完成音声のダウンロード
- `output/audio` への保存
- `PreviewMusicGenerateResponse` 形式への整形

#### 6.4 ACE-Step 制約の反映

##### カバー

- `audio_cover_strength < 1.0` の時は `cfg=1.0` 強制
- `task_type='cover'`

##### リペイント

- `task_type='repaint'`
- 区間バリデーション
  - `0 <= start < end <= duration`
- duration は元音声長と整合するよう確認

#### 6.5 ComfyUI フォールバック

初期導入では **ACE-Step API 専用** にするのが安全。

理由:

- current ComfyUI workflow 側に cover / repaint 相当フローが未接続
- multipart 入力系の差分が大きい
- UX 上も「ACE-Step 接続時のみ利用可」で十分自然

したがって初期リリースでは:

- `ACE_STEP_URL` 未設定時は UI を disabled
- API は 503 を返す

---

### Phase 3: Frontend UI 設計

#### 7.1 UI 配置方針

`renderMusicWorkspace()` の「生成済み音声」ブロックを拡張する。

現状:

- 波形
- トリム範囲
- `✂️ トリミング`
- `クリア`

追加案:

- `🎤 カバー設定`
- `🎨 リペイント設定`
- `✂️ トリミング`
- `クリア`

押すと下に詳細パネルが開く方式にする。

#### 7.2 表示構成

推奨は常時展開ではなく、音声カード内のサブモード切替にする。

- `通常情報`
- `カバー`
- `リペイント`
- `トリミング`

理由:

- 音楽STEPは既に情報量が多い
- 常時表示だと縦に長くなる
- 他STEPとのバランスを維持しやすい

#### 7.3 カバー UI 要素

表示条件:

- `ACE_STEP_URL` が有効
- 参照音声がある or アップロード可能

UI 要素:

- `coverSourceAudio` 選択
  - 方式1: 現在の生成済み音声をそのまま参照
  - 方式2: 別ファイルをアップロード
- `coverStrength` スライダー
- 補足説明
  - 0.2〜0.4: スタイル寄り
  - 0.6〜0.8: 構造維持寄り
- 実行ボタン `🎤 カバー生成`

推奨仕様:

- 初期導入は **現在の生成済み音声を参照元にする** を基本とする
- 必要なら第2段階で「別音声をアップロード」を追加する

#### 7.4 リペイント UI 要素

表示条件:

- `generatedAudio` が存在
- `ACE_STEP_URL` が有効

UI 要素:

- 開始秒
- 終了秒
- 波形上の選択と連動
- 実行ボタン `🎨 リペイント`

推奨仕様:

既存のトリミング波形 UI を再利用し、

- トリム = 残す区間
- リペイント = 再生成する区間

として別モードで扱う。

新規に別波形を作るより、同じ waveform コンポーネントに以下モードを持たせる方が良い。

- `trim`
- `repaint`

---

### Phase 4: Frontend 動作設計

#### 8.1 追加関数候補

`static/js/music_video_studio.js` に追加:

- `produceMusicCover()`
- `produceMusicRepaint()`
- `openMusicCoverPanel()`
- `openMusicRepaintPanel()`
- `syncMusicRepaintRangeFromWaveform()`

#### 8.2 通信方式

通常生成は JSON だが、cover / repaint は multipart が必要。
そのため `fetch` では `FormData` を使う。

##### カバー

- `fetch('/api/v1/production/music/cover', { method: 'POST', body: formData })`

##### リペイント

- `fetch('/api/v1/production/music/repaint', { method: 'POST', body: formData })`

#### 8.3 実行後の状態更新

どちらも成功時は `state.musicStep.generatedAudio` を新しい音声で置換する。
同時に以下も更新:

- `lastGeneratedAt`
- `lastGenerationMode`
- `trimStartSec = 0`
- `trimEndSec = durationSec`
- `notice`
- `canvas.updatedAt`

後続STEPへの影響:

- `sceneImageStep` は歌詞や尺メモはそのまま再利用可能
- `sceneVideoStep` / `finalMvStep` は音声差し替えのため再評価が必要

推奨:

- `invalidateFinalMvOutputs({ keepClip: true })` 相当を流用
- シーン尺自動提案は明示操作時のみ再実行

---

### Phase 5: UX ルール

#### 9.1 カバーの起点

選択肢:

1. 現在の `generatedAudio`
2. 外部アップロード音声

推奨順序:

- 初版: `generatedAudio` を起点にする
- 第2段階: 任意音声アップロード対応を追加

#### 9.2 リペイントの起点

- 現在の `generatedAudio` のみ対象にする
- 外部音声を直接リペイントする運用は初版では不要

#### 9.3 歌詞との関係

リペイント時に歌詞変更を許すかを決める必要がある。

推奨:

- 初版では現在の `lyricsText` / `tagsText` をそのまま使用
- 編集は可能だが、操作前に通常のテキスト欄で修正してから実行

---

## 6. 最小実装スコープ

初回は以下に限定するのが最も安全。

### 実装する

- ACE-Step API 接続時のみ表示
- 現在の生成済み音声を起点にした `カバー`
- 現在の生成済み音声の区間を対象にした `リペイント`
- 既存波形 UI の再利用
- 結果音声で `generatedAudio` を上書き

### 後回しにする

- 別ファイルをカバー元にするアップロード UI
- generation 履歴管理
- cover / repaint 専用の細かなモデル設定
- ComfyUI フォールバック

---

## 7. 具体的な変更対象ファイル

### Backend

- `app_production.py`
  - multipart endpoint 追加
  - ACE-Step multipart helper 追加
  - `/api/v1/production/music/cover`
  - `/api/v1/production/music/repaint`

### Frontend

- `static/js/music_video_studio.js`
  - state 拡張
  - `renderMusicWorkspace()` 拡張
  - カバー / リペイント実行関数追加
  - イベントハンドラ追加
- `static/css/music_video_studio.css`
  - サブモード UI
  - カバー強度スライダー
  - リペイント範囲 UI

### Docs

- `README.md`
- `README_EN.md`
- 必要に応じて `docs/HELP_JP.md`, `docs/HELP_EN.md`

---

## 8. 実装タスク分解

### Task A: Backend 下準備

1. `PreviewMusicGenerateResponse` を cover / repaint にも共通利用できることを確認
2. multipart 処理用の共通ヘルパーを追加
3. ACE-Step API のエラーを production 用メッセージに変換

### Task B: カバーAPI

1. `/api/v1/production/music/cover` 追加
2. `audio_cover_strength` 制約を反映
3. ダウンロード済み音声を既存メディア配信に乗せる

### Task C: リペイントAPI

1. `/api/v1/production/music/repaint` 追加
2. `repainting_start`, `repainting_end` を検証
3. 生成結果を既存音声カードに戻せる形へ整形

### Task D: Frontend 状態追加

1. `musicStep` に repaint / cover 用状態追加
2. restore / save 処理に組み込む
3. 旧状態との互換性を維持

### Task E: Music UI 追加

1. 生成済み音声カードにサブモード導線追加
2. カバー設定 UI 実装
3. リペイント設定 UI 実装
4. ACE-Step 未接続時は非表示または disabled

### Task F: 波形連携

1. トリミングとリペイントのモード切替
2. 数値入力と波形選択を双方向同期
3. 区間表示の視覚差分を追加

### Task G: 後続STEP整合

1. `generatedAudio` 更新時に最終MV関連を無効化
2. シーン尺再提案ボタンとの関係整理
3. notice 文言を cover / repaint 別に最適化

---

## 9. API 仕様メモ

### `POST /api/v1/production/music/cover`

想定レスポンス:

- `success`
- `filename`
- `preview_url`
- `backend`
- `source='generated'`
- `duration_sec`
- `elapsed_time`

### `POST /api/v1/production/music/repaint`

想定レスポンス:

- `success`
- `filename`
- `preview_url`
- `backend`
- `source='generated'`
- `duration_sec`
- `elapsed_time`

両者とも最終的には既存 `produceMusicAudio()` と同じ代入先に流し込める形に揃える。

---

## 10. リスクと注意点

### 10.1 multipart 対応

現状 `mv_studio` の通常音楽生成は JSON ベース。
cover / repaint は `FormData` + `UploadFile` になるため、通常生成のコードを流用しすぎると壊れやすい。

### 10.2 ComfyUI 非対応

cover / repaint を ComfyUI へフォールバックしようとすると設計が一気に複雑になる。
初版では ACE-Step 専用に絞るべき。

### 10.3 履歴管理

カバーやリペイントの結果で `generatedAudio` を都度上書きすると、前の音声へ戻りたい要求が出やすい。

初版:

- 単純上書き

拡張案:

- `generationHistory[]` に保持
- 「ひとつ前に戻す」追加

---

## 11. 結論

最も自然な導入方法は、音楽STEPの既存「生成済み音声」ブロックを中心に、

- `カバー`
- `リペイント`
- `トリミング`

を並列の音声編集操作として追加する形である。

技術的には、最大の差分は **ACE-Step multipart API を production backend に追加すること** で、
UI 側は既存の音声カード・波形・状態管理をかなり再利用できる。

初回実装は **ACE-Step API 接続時限定 / 生成済み音声起点限定** に絞るのが最適。

---

## 12. 実装用チェックリスト

### PR-1: Backend だけ先行

- [ ] `app_production.py` に multipart 共通ヘルパーを追加
- [ ] `POST /api/v1/production/music/cover` を追加
- [ ] `POST /api/v1/production/music/repaint` を追加
- [ ] `ACE_STEP_URL` 未設定時に 503 を返す
- [ ] カバー時に `audio_cover_strength < 1.0` なら `cfg=1.0` を強制
- [ ] リペイント時に `repainting_start < repainting_end` を検証
- [ ] 生成音声を既存の production media 配信経路で返す
- [ ] `PreviewMusicGenerateResponse` と互換のレスポンスを返す

#### PR-1 の受け入れ条件

- [ ] curl / フォーム送信で `cover` が成功する
- [ ] curl / フォーム送信で `repaint` が成功する
- [ ] 失敗時に 500 生テキストではなく意味のある `detail` が返る
- [ ] 既存 `/api/v1/production/music/generate` に影響がない

### PR-2: Frontend state と API 接続

- [ ] `state.musicStep` に `coverStrength` を追加
- [ ] `state.musicStep` に `repaintStartSec` / `repaintEndSec` を追加
- [ ] `state.musicStep` に `musicEditPanel` を追加
- [ ] restore/save 経路に新規 state を組み込む
- [ ] `produceMusicCover()` を追加
- [ ] `produceMusicRepaint()` を追加
- [ ] 成功時に `generatedAudio` を既存形式で更新する
- [ ] `lastGenerationMode` を更新する

#### PR-2 の受け入れ条件

- [ ] ブラウザ再読込後も cover / repaint 設定が保持される
- [ ] cover / repaint 実行後に既存音声カードがそのまま更新される
- [ ] `sceneImageStep` 以降の state を壊さない

### PR-3: Music UI 組み込み

- [ ] 生成済み音声カードに `カバー` / `リペイント` / `トリミング` の切替を追加
- [ ] カバー強度スライダーを追加
- [ ] リペイント区間入力 UI を追加
- [ ] ACE-Step 未接続時はボタンを非表示または disabled にする
- [ ] 実行中の busy 表示を追加
- [ ] 成功/失敗 notice を cover / repaint 別に表示する

#### PR-3 の受け入れ条件

- [ ] UI が縦に伸びすぎない
- [ ] 既存 `音楽制作` / `外部音楽読込` / `トリミング` の導線を壊さない
- [ ] ボタン配置が他STEPと同程度の密度で収まる

### PR-4: 波形連携

- [ ] 波形 UI に `trim` / `repaint` モードを追加
- [ ] リペイント範囲と数値入力を同期
- [ ] リペイント対象区間を視覚的に区別する
- [ ] トリミング操作との干渉を防ぐ

#### PR-4 の受け入れ条件

- [ ] 波形上で設定した区間が repaint input に反映される
- [ ] trim 用の挙動が従来どおり動く
- [ ] repaint 範囲が音声全体長を超えない

### PR-5: 仕上げ

- [ ] `README.md` を更新
- [ ] `README_EN.md` を更新
- [ ] 必要なら `docs/HELP_JP.md` / `docs/HELP_EN.md` を更新
- [ ] 手動テスト観点を追記

---

## 13. 手動テスト観点

### カバー

- [ ] 生成済み音声を起点に cover 実行できる
- [ ] `coverStrength = 0.8` で成功する
- [ ] `coverStrength = 0.4` でも成功し、CFG 強制が効く
- [ ] 実行後の音声が再生できる
- [ ] 再生成後も trim が使える

### リペイント

- [ ] 0-5 秒など短区間で repaint 実行できる
- [ ] 終了 <= 開始 の場合は実行前に弾く
- [ ] 全体長を超える値を UI / API の両方で弾く
- [ ] repaint 後の音声が再生できる

### 後続STEP

- [ ] scene image 側の参照音声表示が更新される
- [ ] final MV 側の出力は再生成前提に戻る
- [ ] 既存セッションを開いても壊れない

---

## 14. 最初の実装着手順

迷わず進めるなら、最初の着手順は以下。

1. `app_production.py` に multipart helper を追加
2. `music/cover` と `music/repaint` API を追加
3. API 単体で成功確認
4. `music_video_studio.js` の state だけ先に拡張
5. 音声カードに最小 UI を追加
6. 最後に波形 repaint 連携を入れる

この順序なら、backend 単体確認 → UI 接続 → 波形統合の順で安全に進められる。