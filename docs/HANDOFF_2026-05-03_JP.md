# 中断メモ / 再開用ハンドオフ

最終更新: 2026-05-03

このファイルは、`Music Video Studio` 開発を後で再開するための引き継ぎメモです。

---

## 1. 今回までの到達点

現在の主UIは `Production 版 Music Video Studio` です。

主要構成:
- バックエンド: [app_production.py](../app_production.py)
- フロント: [static/music_video_studio.html](../static/music_video_studio.html)
- フロントロジック: [static/js/music_video_studio.js](../static/js/music_video_studio.js)
- スタイル: [static/css/music_video_studio.css](../static/css/music_video_studio.css)

実装済みの主な改善:
- STEP中心UIへの整理
- music STEP の一括実行整理
- 歌詞だけ / タグだけ再生成
- 音声トリミング
- 音声リペイント（ACE-Step API 前提）
- scene image のシーン数ルールベース初期化
- 尺・遷移の固定シーン数提案
- scene prompt 数と scene count の整合修正
- scene visual style（アニメ / 実写 / イラスト / 映画 / ラインアート / ドット絵）
- visual style の scene image / scene video への引き継ぎ
- final MV 再編集導線文言整理

---

## 2. 現在の重要仕様

### scene count の扱い
- music → scene_image へ移る時に、音楽尺から初期 scene count を決める
- 標準 / Qwen系の平均 scene 尺: 約 5 秒
- LTX 系の平均 scene 尺: 約 8 秒
- `🧩 尺・遷移を自動提案` は **現在の scene count を変えずに** 尺と遷移だけを再提案する

### visual style の扱い
- scene image STEP で style を選ぶ
- prompt 生成に反映
- image 生成に反映
- scene video prompt / 生成にも反映

### music repaint
- `/api/v1/production/music/repaint`
- ACE-Step API が必要
- UI では trim 用の開始 / 終了指定を repaint にも兼用

---

## 3. プレゼン資料の扱い

プレゼン資料は `lt/` に集約済みです。

注意:
- `lt/` は `.gitignore` で除外済み
- そのため、発表資料は **git には残らないローカル作業物** です

主なファイル:
- [lt/MV_STUDIO_PRESENTATION_JP.md](../lt/MV_STUDIO_PRESENTATION_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md](../lt/MV_STUDIO_PRESENTATION_DIAGRAMS_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md](../lt/MV_STUDIO_PRESENTATION_DIAGRAMS_WHITE_JP.md)
- [lt/MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md](../lt/MV_STUDIO_PRESENTATION_DIAGRAMS_ORIGINAL_JP.md)
- [lt/README.md](../lt/README.md)

---

## 4. 中断時点で未整理の可能性がある項目

優先度高:
- `app_production.py` の既存変更全体の動作確認
- music repaint の実環境確認
- scene visual style が全 workflow で期待通り効くかの確認
- final MV までの通し確認

優先度中:
- UI 文言の最終整理
- 各 STEP の補助説明の過不足確認
- preset ごとの差異説明の明文化

優先度低:
- プレゼン資料の最終仕上げ
- `lt/final/` など本番用分離
- PNG 書き出しサイズの固定化

---

## 5. 再開時に最初に見る場所

1. [docs/HANDOFF_2026-05-03_JP.md](HANDOFF_2026-05-03_JP.md)
2. [README.md](../README.md)
3. [app_production.py](../app_production.py)
4. [static/js/music_video_studio.js](../static/js/music_video_studio.js)
5. [lt/README.md](../lt/README.md)

---

## 6. 再開時の推奨タスク順

1. Production UI を起動
2. character → story → music → scene_image → scene_video → final_mv を一通り確認
3. repaint と selective regenerate を確認
4. scene visual style を変えて image / video の差を確認
5. 必要なら UI 文言と導線だけ先に微修正

---

## 7. 備考

このアプリ開発を再開する場合、まずは **機能追加よりも通し動作確認** を優先するのが安全です。

特に以下を重点確認:
- music STEP の保持 / 再生成条件
- scene count の自動設定タイミング
- scene plan が scene count を勝手に変えないこと
- style hint の backend / frontend の受け渡し整合
