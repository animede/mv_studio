# Music Video Studio 図版集（白背景固定版）

最終更新: 2026-05-03

PNG書き出しと 16:9 スライド貼り込みを前提に、白背景固定・横長寄りで整えた Mermaid 図版集です。

最初に作成した図は [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md) に保存しています。

関連資料:
- [lt/MV_STUDIO_PRESENTATION_JP.md](MV_STUDIO_PRESENTATION_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md](MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md)
- [lt/diagrams/README.md](diagrams/README.md)

---

## 01. UI責務の再設計

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","primaryColor":"#EAF1FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EDF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF4E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#FFFFFF","clusterBorder":"#D7DEEA"},"flowchart":{"nodeSpacing":34,"rankSpacing":48,"curve":"linear","htmlLabels":false}} }%%
flowchart LR
    subgraph OLD[旧UI]
        direction TB
        A[simple_video\n統合UI]
        B[入口が不明瞭]
        C[機能は強力]
        A --> B
        A --> C
    end

    subgraph NEW[新UI]
        direction TB
        D[Music Video Studio\n制作導線UI]
        E[開始点が明確]
        F[差し替えやすい]
        G[既存資産を活用]
        D --> E
        D --> F
        D --> G
    end
    classDef core fill:#EAF1FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
    classDef assist fill:#EDF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
    class A,D core;
    class B,C,E,F,G assist;
```

ソース: [lt/diagrams/white/01_ui_responsibility_shift_white.mmd](diagrams/white/01_ui_responsibility_shift_white.mmd)

---

## 02. 継承型アーキテクチャ

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","primaryColor":"#EAF1FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EDF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF4E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#FFFFFF","clusterBorder":"#D7DEEA"},"flowchart":{"nodeSpacing":36,"rankSpacing":50,"curve":"linear","htmlLabels":false}} }%%
flowchart LR
    U[ユーザー] --> GUI[MV Studio UI] --> API[FastAPI制御層\napp_production.py]

    subgraph RES[状態 / 既存資産]
        direction TB
        STATE[制作状態\nsession]
        LEGACY[既存資産\nsimple_video系]
        MEDIA[成果物\nimage / video / audio / movie]
    end

    subgraph GEN[AI / 生成基盤]
        direction TB
        AI[AI基盤]
        LLM[LLM\n計画 / 補助]
        IMG[画像生成\nT2I / I2I]
        VID[動画生成\nI2V / FLF / LTX]
        MUS[音楽生成\nACE-Step]
        AI --> LLM
        AI --> IMG
        AI --> VID
        AI --> MUS
    end

    API --> RES
    API --> GEN
    classDef core fill:#EAF1FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
    classDef assist fill:#EDF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
    classDef media fill:#FFF4E8,stroke:#D97706,color:#4A2A00,stroke-width:1.4px;
    class U,GUI,API,STATE,LEGACY core;
    class AI,LLM assist;
    class IMG,VID,MUS,MEDIA media;
```

ソース: [lt/diagrams/white/02_system_layers_white.mmd](diagrams/white/02_system_layers_white.mmd)

---

## 03. AIの役割分担

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","primaryColor":"#EAF1FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EDF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF4E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#FFFFFF","clusterBorder":"#D7DEEA"},"flowchart":{"nodeSpacing":34,"rankSpacing":48,"curve":"linear","htmlLabels":false}} }%%
flowchart LR
    subgraph FLOW[編集フロー]
        direction TB
        IDEA[意図 / 世界観]
        MUSIC[音楽STEP]
        SCENEIMG[画像STEP]
        SCENEVID[動画STEP]
        FINAL[完成MV]
        IDEA --> MUSIC --> SCENEIMG --> SCENEVID --> FINAL
    end

    subgraph PLAN[計画AI]
        direction TB
        L1[LLM\nシナリオ]
        L2[LLM\n歌詞 / タグ]
        L3[LLM\n尺 / 遷移]
        L4[LLM\n画像プロンプト]
        L5[LLM\n翻訳 / 補助]
    end

    subgraph MEDIAAI[生成AI]
        direction TB
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
    classDef core fill:#EAF1FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
    classDef assist fill:#EDF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
    classDef media fill:#FFF4E8,stroke:#D97706,color:#4A2A00,stroke-width:1.4px;
    class IDEA,MUSIC,SCENEIMG,SCENEVID,FINAL core;
    class L1,L2,L3,L4,L5 assist;
    class M1,M2,M3 media;
```

ソース: [lt/diagrams/white/03_ai_usage_map_white.mmd](diagrams/white/03_ai_usage_map_white.mmd)

---

## 04. STEPは介入点

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","primaryColor":"#EAF1FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EDF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF4E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#FFFFFF","clusterBorder":"#D7DEEA"},"flowchart":{"nodeSpacing":36,"rankSpacing":46,"curve":"linear","htmlLabels":false}} }%%
flowchart LR
    A[Story\nidea / scenario] --> B[Music\nlyrics / tags / audio] --> C[Scene Image\ncount / prompts / images] --> D[Scene Video\nprompts / videos / transitions] --> E[Final MV\nclip / movie]

    A -.手修正.-> A
    B -.歌詞 / タグ再生成.-> B
    C -.尺・遷移 / 画像修正.-> C
    D -.動画差し替え / 遷移調整.-> D
    E -.戻る.-> B
    E -.戻る.-> C
    E -.戻る.-> D
    classDef core fill:#EAF1FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
    class A,B,C,D,E core;
```

ソース: [lt/diagrams/white/04_step_dataflow_white.mmd](diagrams/white/04_step_dataflow_white.mmd)

---

## 05. 制作OSへの進化

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#FFFFFF","primaryColor":"#EAF1FF","primaryBorderColor":"#4C6FFF","primaryTextColor":"#1F2A44","secondaryColor":"#EDF9F1","secondaryBorderColor":"#2E9B62","tertiaryColor":"#FFF4E8","tertiaryBorderColor":"#D97706","lineColor":"#5B6475","fontFamily":"Inter, BIZ UDPGothic, sans-serif","fontSize":"16px","clusterBkg":"#FFFFFF","clusterBorder":"#D7DEEA"},"flowchart":{"nodeSpacing":38,"rankSpacing":48,"curve":"linear","htmlLabels":false}} }%%
flowchart LR
    Now[現在\nSTEP中心UI] --> Next1[タイムラインUI]
    Now --> Next2[音源解析で\n尺最適化]
    Now --> Next3[シーン単位\nスタイル制御]
    Now --> Next4[再同期 / 再編集\nの可視化]
    classDef core fill:#EAF1FF,stroke:#4C6FFF,color:#1F2A44,stroke-width:1.4px;
    classDef assist fill:#EDF9F1,stroke:#2E9B62,color:#163828,stroke-width:1.4px;
    class Now core;
    class Next1,Next2,Next3,Next4 assist;
```

ソース: [lt/diagrams/white/05_roadmap_white.mmd](diagrams/white/05_roadmap_white.mmd)
