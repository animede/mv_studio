# Music Video Studio キャラクタ作成STEP 実装計画

最終更新: 2026-04-25

## 目的

`Music Video Studio` の `キャラクタ作成` STEP は、まず新規設計せず、`simple_video` にあるキャラクタ生成エリアの機能をできるだけそのまま移植して成立させます。

方針:

- 先に **機能移植** を優先する
- UI の見た目調整は最小限にする
- 既存の API / workflow / 状態項目は極力そのまま再利用する
- `キャラクタ作成` STEP を、後続の `シーン画像作成` / `シーン動画作成` の基準入力にする

---

## 1. 移植対象の機能範囲

`simple_video` から、そのまま持ってくる対象は以下です。

### A. 参照画像入力

- `📥 画像ドロップ` 3スロット
	- `ref1`
	- `ref2`
	- `ref3`
- `ref3` 活用モード
	- 背景として
	- 画風として
	- アニメ風に
- I2I 詳細設定
	- workflow
	- denoise
	- cfg

根拠:

- [static/js/simple_video.js](static/js/simple_video.js#L1683-L1748)
- [docs/TECHNICAL_JP.md](docs/TECHNICAL_JP.md#L314-L374)

### B. キャラクタ一覧 / 登録

- `👤 キャラクタ一覧`
- `📝 キャラクタ登録`
- 更新
- 選択解除
- `@キャラ名` トークン利用

根拠:

- [static/js/simple_video.js](static/js/simple_video.js#L1753-L1780)
- [static/js/simple_video.js](static/js/simple_video.js#L3134-L3175)
- [app.py](app.py#L4353-L4425)

### C. キャラ合成画像生成

- `何を描きたい？` プロンプト
- `初期画像を生成` ではなく、`キャラ合成画像を生成` として扱う核機能
- `@キャラ名` と `ref1/ref2/ref3` を `Picture N` に展開する処理
- multi-image EDIT ワークフロー利用
- 出力を `characterImage` として保存

根拠:

- [static/js/simple_video.js](static/js/simple_video.js#L8480-L8708)

### D. キャラクターシート生成

- `キャラクターシート`
- `背景なし`
- 生成後の `characterSheetImage` 保存
- 後続 STEP の参照画像切替に利用

根拠:

- [static/js/simple_video.js](static/js/simple_video.js#L8775-L8835)
- [docs/TECHNICAL_JP.md](docs/TECHNICAL_JP.md#L395-L430)

### E. VLM / VLLM による画像解析

- キー画像 / 参照画像の解析実行
- 解析結果テキストの保持
- 解析結果をキャラクタ設計メモへ反映
- 必要に応じて後続のシナリオ・シーンプロンプトへ受け渡し

初回実装では、`simple_video` の既存 `VLM` 解析機能をそのまま再利用します。
ユーザー要望上は `VLLM` 解析追加として扱いますが、実装上の既存資産は `VLM analyze API` です。

根拠:

- [static/js/simple_video.js](static/js/simple_video.js#L8241-L8465)
- [app.py](app.py#L4050)
- [docs/USAGE_JP.md](docs/USAGE_JP.md#L23-L26)

### F. 参照画像の優先順位と後続受け渡し

最低限、以下の既存ロジックを踏襲します。

- `characterSheetImage > characterImage > keyImage > ref1`
- `i2iRefSource`
- `useCharSheetAsRef`
- `i2iRefRole`
- `keyImageAnalysis`

根拠:

- [docs/TECHNICAL_JP.md](docs/TECHNICAL_JP.md#L329-L395)

---

## 2. 今回は変えないもの

初回実装では、以下はリファクタしません。

- `simple_video` の workflow 選択ロジックの大幅な再設計
- キャラクタ登録 API の新規設計
- `@キャラ名` 記法の変更
- 参照画像解決ロジックの再定義
- キャラクタ生成とシーン生成を別形式のデータモデルへ変換すること
- VLM/VLLM 解析 API 自体の再設計

つまり、**まずは既存資産をそのまま STEP 内へ載せる** ことを優先します。

---

## 3. 実装方式

### 方針: 「移植」優先

実装は新規で作り直さず、`simple_video.js` のキャラクタ関連部分を段階的に分離して再利用します。

推奨分割:

1. `simple_video` のキャラクタ関連 UI/状態/API 呼び出しを抽出
2. `Music Video Studio` 側の `キャラクタ作成` STEP で呼ぶ
3. 最後に見た目だけ新UIに合わせて薄く整える

---

## 4. 実装フェーズ

## Phase 1: 状態モデルを移す

`キャラクタ作成` STEP 用 state として、以下をそのまま持ち込みます。

- `dropSlots`
- `selectedCharacter`
- `characterImage`
- `characterSheetImage`
- `charSheetNobg`
- `useCharSheetAsRef`
- `charSheetRefWorkflow`
- `i2iRefSource`
- `i2iRefRole`
- `keyImage`
- `keyImageAnalysis`
- `keyImageAnalysisRaw`
- `preparedInitialImage`
- `imagePrompt`
- `i2iDenoise`
- `i2iCfg`
- `i2iRefineWorkflow`
- `ref3UseMode`
- `ref3ModeEnabled`

移植元:

- [static/js/simple_video.js](static/js/simple_video.js#L653-L756)

成果物:

- `Music Video Studio` 側 state に `characterStep` 相当のまとまりを追加
- セッション保存対象へ追加

## Phase 2: バックエンド再利用

既存の参照画像 API をそのまま使えるようにします。

最低限必要な既存 API:

- `GET /api/v1/ref-images`
- `POST /api/v1/ref-images`
- 参照画像ファイル配信 API
- `POST /api/v1/vlm/analyze`

移植元:

- [app.py](app.py#L4353-L4425)

判断:

- 可能なら `app.py` の実装を共通化
- 難しければ `app_production.py` 側へ同等 API を複製

## Phase 3: UI を STEP に埋め込む

`STEP制作・編集エリア` の `キャラクタ作成` を選択したとき、右側作業領域に以下を表示します。

表示順:

1. 参照画像入力
2. VLM / VLLM 画像解析
3. キャラクタ一覧 / 登録
4. キャラ合成プロンプト
5. キャラ合成画像生成
6. キャラクターシート生成
7. 内部参照画像プレビュー

この段階では、`simple_video` の DOM 構成を大きく崩さず流用して構いません。

移植元 UI:

- [static/js/simple_video.js](static/js/simple_video.js#L1683-L1815)

## Phase 4: 生成処理を接続

接続対象:

- `runKeyImageAnalysis()`
- `runCharacterImageGeneration()`
- `runCharacterSheetGeneration()`
- キャラクタ一覧更新
- キャラクタ登録
- 選択解除

移植元:

- [static/js/simple_video.js](static/js/simple_video.js#L3134-L3175)
- [static/js/simple_video.js](static/js/simple_video.js#L8241-L8465)
- [static/js/simple_video.js](static/js/simple_video.js#L8480-L8835)

## Phase 5: 後続 STEP 連携

`キャラクタ作成` で決まった成果物を、後続 STEP へ渡します。

連携対象:

- `story` へ: キャラ定義 / 固定タグ / 禁止要素
- `scene_image` へ: `characterImage` / `characterSheetImage` / `dropSlots` / `keyImageAnalysis`
- `scene_video` へ: `i2iRefSource` / `useCharSheetAsRef`

最重要:

- `char_edit_*` 系の後続実行で参照画像の意味が変わらないこと

---

## 5. 画面構成案

`キャラクタ作成` STEP の右作業エリアは、初回は次の縦積みで十分です。

1. `参照画像`
2. `画像解析`
3. `キャラクタ一覧 / 登録`
4. `キャラ合成プロンプト`
5. `生成操作`
6. `生成結果`
7. `次STEPへの受け渡し情報`

重要なのは見た目より、**simple_video と同じ意味で動くこと** です。

---

## 6. 受け入れ条件

初回実装完了の判定は以下です。

- `ref1/ref2/ref3` を登録できる
- VLM / VLLM 画像解析を実行できる
- `keyImageAnalysis` が state 保存される
- キャラクタ一覧を表示・登録・解除できる
- `@キャラ名` を含むプロンプトでキャラ合成画像を生成できる
- キャラクターシートを生成できる
- `characterImage` / `characterSheetImage` が state 保存される
- 後続 STEP がその参照画像を使える
- `simple_video` の `char_edit_i2i_flf` と同じ前提で素材が揃う

---

## 7. 実装順の推奨

着手順:

1. state 移植
2. 参照画像 API 接続
3. VLM / VLLM 解析 UI と API 接続
4. キャラクタ一覧 / 登録 UI
5. 画像ドロップ UI
6. キャラ合成画像生成
7. キャラクターシート生成
8. 後続 STEP 連携
9. 見た目の調整

この順なら、機能が途中でも段階確認できます。

---

## 8. 結論

`キャラクタ作成` STEP は、新しく抽象化し直すよりも、まず `simple_video` のキャラクタ生成エリアをそのまま移すのが安全です。

特に初回実装では:

- UI 再設計より **既存機能の完全移植** を優先
- `char_edit_*` 系パイプラインに必要な参照画像資産を壊さない
- `characterImage` / `characterSheetImage` / `dropSlots` / `keyImageAnalysis` を新UIの共通資産にする

これにより、`Music Video Studio` の `キャラクタ作成` は単なる入力フォームではなく、`simple_video` の実運用で使われてきた **キャラ基準生成の中核STEP** として立ち上げられます。
