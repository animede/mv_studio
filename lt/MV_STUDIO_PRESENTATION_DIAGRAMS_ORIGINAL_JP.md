# Music Video Studio 図版集（初版）

最終更新: 2026-05-03

最初に作成した Mermaid 図を、そのまま保持するための保存版です。

関連資料:
- [lt/MV_STUDIO_PRESENTATION_JP.md](MV_STUDIO_PRESENTATION_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md)
- [lt/diagrams/original/README.md](diagrams/original/README.md)

---

## 01. 旧UIから新UIへの責務移動

```mermaid
flowchart TB
	subgraph OLD[旧UI]
		A[simple_video UI\n機能が1画面に集中]
		B[起動直後に迷いやすい]
		C[上級者には強力]
		A --> B
		A --> C
	end

	subgraph NEW[新UI]
		D[Music Video Studio\n入口と制作順を前面化]
		E[開始点が明確]
		F[途中成果物へ戻りやすい]
		G[既存パイプラインを内部活用]
		D --> E
		D --> F
		D --> G
	end
```

ソース: [lt/diagrams/original/01_ui_responsibility_shift_original.mmd](diagrams/original/01_ui_responsibility_shift_original.mmd)

---

## 02. システム層構造

```mermaid
flowchart TD
	U[ユーザー] --> GUI[Music Video Studio UI\nproduction frontend]
	GUI --> API[FastAPI 制御層\napp_production.py]
	API --> STATE[制作状態\ndata/production_sessions]
	API --> LEGACY[既存ロジック資産\nsimple_video 系知見]
	API --> AI[AI / 生成基盤]

	AI --> LLM[LLM\n構成・歌詞・タグ・尺・遷移・プロンプト補助]
	AI --> IMG[画像生成モデル\nT2I / I2I]
	AI --> VID[動画生成モデル\nI2V / FLF / LTX]
	AI --> MUS[音楽生成モデル\nACE-Step 等]

	API --> MEDIA[成果物管理\nimage / video / audio / movie]
```

ソース: [lt/diagrams/original/02_system_layers_original.mmd](diagrams/original/02_system_layers_original.mmd)

---

## 03. AI使用箇所の全体像

```mermaid
flowchart TD
	subgraph FLOW[ユーザー編集フロー]
		IDEA[意図 / 世界観]
		MUSIC[音楽STEP]
		SCENEIMG[シーン画像STEP]
		SCENEVID[シーン動画STEP]
		FINAL[完成MV]
		IDEA --> MUSIC --> SCENEIMG --> SCENEVID --> FINAL
	end

	subgraph PLAN[計画・補助AI]
		L1[LLM\nシナリオ生成]
		L2[LLM\n歌詞 / タグ / 構成]
		L3[LLM\n尺 / 遷移提案]
		L4[LLM\n画像プロンプト生成]
		L5[LLM\n翻訳 / テキスト補助]
	end

	subgraph MEDIAAI[メディア生成AI]
		M1[画像生成モデル\nT2I / I2I]
		M2[動画生成モデル\nI2V / FLF / LTX]
		M3[音楽生成モデル\nACE-Step]
	end

	IDEA --> L1
	IDEA --> L2
	IDEA --> L5
	MUSIC --> L3 --> SCENEIMG
	MUSIC --> L4 --> SCENEIMG
	SCENEIMG --> M1 --> SCENEVID
	MUSIC --> M3 --> FINAL
	SCENEVID --> M2 --> FINAL
```

ソース: [lt/diagrams/original/03_ai_usage_map_original.mmd](diagrams/original/03_ai_usage_map_original.mmd)

---

## 04. データフローと介入点

```mermaid
flowchart TD
	A[Story Step\nidea / world / scenario] --> B[Music Step\nlyrics / tags / arrangement / audio]
	B --> C[Scene Image Step\nscene count / durations / prompts / images]
	C --> D[Scene Video Step\nvideo prompts / videos / transitions]
	D --> E[Final MV Step\nclip / final movie]

	A -.手修正 / 再生成.-> A
	B -.歌詞だけ / タグだけ再生成.-> B
	C -.尺・遷移再提案 / プロンプト修正 / 画像差し替え.-> C
	D -.動画差し替え / 遷移再調整.-> D
	E -.再編集導線で戻る.-> B
	E -.再編集導線で戻る.-> C
	E -.再編集導線で戻る.-> D
```

ソース: [lt/diagrams/original/04_step_dataflow_original.mmd](diagrams/original/04_step_dataflow_original.mmd)

---

## 05. 今後の進化方向

```mermaid
flowchart TB
	Now[現在\nSTEP中心のMV制作UI]
	Now --> Next1[タイムライン中心UI]
	Now --> Next2[音源解析ベースの尺最適化]
	Now --> Next3[シーン単位スタイル制御]
	Now --> Next4[再同期 / 再編集の可視化]
```

ソース: [lt/diagrams/original/05_roadmap_original.mmd](diagrams/original/05_roadmap_original.mmd)
