# Music Video Studio 図版集

最終更新: 2026-05-03

プレゼン資料から Mermaid 図だけを抜き出した、画像化・貼り付け向けの簡易版です。

白背景固定・16:9貼り込み向けの版は [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md) を参照してください。最初に作成した図は [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md) に保存しています。

関連資料:
- [lt/MV_STUDIO_PRESENTATION_JP.md](MV_STUDIO_PRESENTATION_JP.md)
- [lt/diagrams/README.md](diagrams/README.md)

---

## 01. UI責務の再設計

用途: 改善前後のUI責務の違いを1枚で説明する

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#E8F0FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EEF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF3E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#F7F9FC","clusterBorder":"#C7D2E3"},"flowchart":{"nodeSpacing":28,"rankSpacing":42,"curve":"basis","htmlLabels":false}} }%%
flowchart TB
	subgraph OLD[旧UI]
		A[simple_video\n統合UI]
		B[入口が不明瞭]
		C[機能は強力]
		A --> B
		A --> C
	end

	subgraph NEW[新UI]
		D[Music Video Studio\n制作導線UI]
		E[開始点が明確]
		F[差し替えやすい]
		G[既存資産を活用]
		D --> E
		D --> F
		D --> G
	end
	classDef core fill:#E8F0FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
	classDef ai fill:#EEF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
	class A,D core;
	class B,C,E,F,G ai;
```

ソース: [lt/diagrams/01_ui_responsibility_shift.mmd](diagrams/01_ui_responsibility_shift.mmd)

---

## 02. 継承型アーキテクチャ

用途: 新UIと既存資産の継承関係を説明する

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#E8F0FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EEF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF3E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#F7F9FC","clusterBorder":"#C7D2E3"},"flowchart":{"nodeSpacing":28,"rankSpacing":42,"curve":"basis","htmlLabels":false}} }%%
flowchart TD
	U[ユーザー] --> GUI[MV Studio UI]
	GUI --> API[FastAPI制御層\napp_production.py]
	API --> STATE[制作状態\nsession]
	API --> LEGACY[既存資産\nsimple_video系]
	API --> AI[AI / 生成基盤]

	AI --> LLM[LLM\n計画 / 補助]
	AI --> IMG[画像生成\nT2I / I2I]
	AI --> VID[動画生成\nI2V / FLF / LTX]
	AI --> MUS[音楽生成\nACE-Step]

	API --> MEDIA[成果物\nimage / video / audio / movie]
	classDef core fill:#E8F0FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
	classDef ai fill:#EEF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
	classDef media fill:#FFF3E8,stroke:#D97706,color:#4A2A00,stroke-width:1.4px;
	class U,GUI,API,STATE,LEGACY,MEDIA core;
	class AI,LLM ai;
	class IMG,VID,MUS media;
```

ソース: [lt/diagrams/02_system_layers.mmd](diagrams/02_system_layers.mmd)

---

## 03. AIの役割分担

用途: 計画AIとメディア生成AIの役割分担を説明する

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#E8F0FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EEF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF3E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#F7F9FC","clusterBorder":"#C7D2E3"},"flowchart":{"nodeSpacing":28,"rankSpacing":42,"curve":"basis","htmlLabels":false}} }%%
flowchart TD
	subgraph FLOW[ユーザー編集フロー]
		IDEA[意図 / 世界観]
		MUSIC[音楽STEP]
		SCENEIMG[画像STEP]
		SCENEVID[動画STEP]
		FINAL[完成MV]
		IDEA --> MUSIC --> SCENEIMG --> SCENEVID --> FINAL
	end

	subgraph PLAN[計画・補助AI]
		L1[LLM\nシナリオ]
		L2[LLM\n歌詞 / タグ]
		L3[LLM\n尺 / 遷移]
		L4[LLM\n画像プロンプト]
		L5[LLM\n翻訳 / 補助]
	end

	subgraph MEDIAAI[メディア生成AI]
		M1[画像生成\nT2I / I2I]
		M2[動画生成\nI2V / FLF / LTX]
		M3[音楽生成\nACE-Step]
	end

	IDEA --> L1
	IDEA --> L2
	IDEA --> L5
	MUSIC --> L3 --> SCENEIMG
	MUSIC --> L4 --> SCENEIMG
	SCENEIMG --> M1 --> SCENEVID
	MUSIC --> M3 --> FINAL
	SCENEVID --> M2 --> FINAL
	classDef core fill:#E8F0FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
	classDef ai fill:#EEF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
	classDef media fill:#FFF3E8,stroke:#D97706,color:#4A2A00,stroke-width:1.4px;
	class IDEA,MUSIC,SCENEIMG,SCENEVID,FINAL core;
	class L1,L2,L3,L4,L5 ai;
	class M1,M2,M3 media;
```

ソース: [lt/diagrams/03_ai_usage_map.mmd](diagrams/03_ai_usage_map.mmd)

---

## 04. STEPは介入点

用途: STEPごとの介入可能ポイントを説明する

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#E8F0FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EEF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF3E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#F7F9FC","clusterBorder":"#C7D2E3"},"flowchart":{"nodeSpacing":28,"rankSpacing":42,"curve":"basis","htmlLabels":false}} }%%
flowchart TD
	A[Story\nidea / scenario] --> B[Music\nlyrics / tags / audio]
	B --> C[Scene Image\ncount / prompts / images]
	C --> D[Scene Video\nprompts / videos / transitions]
	D --> E[Final MV\nclip / movie]

	A -.手修正 / 再生成.-> A
	B -.歌詞だけ / タグだけ再生成.-> B
	C -.尺・遷移再提案 / プロンプト修正 / 画像差し替え.-> C
	D -.動画差し替え / 遷移再調整.-> D
	E -.再編集導線で戻る.-> B
	E -.再編集導線で戻る.-> C
	E -.再編集導線で戻る.-> D
	classDef core fill:#E8F0FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
	class A,B,C,D,E core;
```

ソース: [lt/diagrams/04_step_dataflow.mmd](diagrams/04_step_dataflow.mmd)

---

## 05. 制作OSへの進化

用途: 拡張ロードマップを短く示す

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#E8F0FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EEF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF3E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#F7F9FC","clusterBorder":"#C7D2E3"},"flowchart":{"nodeSpacing":28,"rankSpacing":42,"curve":"basis","htmlLabels":false}} }%%
flowchart TB
	Now[現在\nSTEP中心UI]
	Now --> Next1[タイムラインUI]
	Now --> Next2[音源解析で尺最適化]
	Now --> Next3[シーン単位スタイル制御]
	Now --> Next4[再同期 / 再編集の可視化]
	classDef core fill:#E8F0FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
	classDef ai fill:#EEF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
	class Now core;
	class Next1,Next2,Next3,Next4 ai;
```

ソース: [lt/diagrams/05_roadmap.mmd](diagrams/05_roadmap.mmd)
