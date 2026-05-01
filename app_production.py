from __future__ import annotations

import base64
import json
import math
import os
import random
import re
import shutil
import subprocess
import time
import uuid
from threading import Lock
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

try:
    from PIL import Image, ImageFilter, ImageOps
except ImportError:  # Pillow is optional until image post-processing is used.
    Image = None
    ImageFilter = None
    ImageOps = None

from openai_chat import chat_req, vlm_req

# Auto-load .env files so production gets the same VLM / OpenAI settings
# as the main app, even when launched directly.
try:
    from dotenv import load_dotenv as _load_dotenv
    _env_file = Path(__file__).resolve().parent / ".env"
    _parent_env = Path(__file__).resolve().parent.parent / ".env"
    if _env_file.is_file():
        _load_dotenv(_env_file, override=False)
    if _parent_env.is_file():
        _load_dotenv(_parent_env, override=False)
except ImportError:
    pass

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
WORKFLOWS_DIR = BASE_DIR / "workflows"
PREVIEW_STATE_DIR = DATA_DIR / "production_sessions"
PREVIEW_STATE_FILE = DATA_DIR / "production_state.json"
REF_IMAGES_DIR = DATA_DIR / "ref_images"
REF_IMAGES_INDEX = DATA_DIR / "ref_images.json"


def _is_comfyui_dir(path: Path) -> bool:
    try:
        return path.is_dir() and (path / "main.py").exists() and (path / "input").is_dir()
    except Exception:
        return False


def _find_comfyui_dir() -> Optional[Path]:
    env_dir = str(os.environ.get("COMFYUI_DIR", "")).strip()
    if env_dir:
        candidate = Path(env_dir).expanduser().resolve()
        if _is_comfyui_dir(candidate):
            return candidate

    candidate = BASE_DIR
    while True:
        if _is_comfyui_dir(candidate):
            return candidate.resolve()
        try:
            siblings = sorted(candidate.iterdir())
            named = [d for d in siblings if d.is_dir() and d.name.lower().startswith("comfyui")]
            others = [d for d in siblings if d.is_dir() and not d.name.lower().startswith("comfyui")]
            for sibling in named + others:
                if _is_comfyui_dir(sibling):
                    return sibling.resolve()
        except PermissionError:
            pass
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent
    return None


_comfyui_dir = _find_comfyui_dir()
_comfy_input_env = str(os.environ.get("COMFYUI_INPUT_DIR", "")).strip()
if _comfy_input_env:
    COMFY_INPUT_DIR = Path(_comfy_input_env).expanduser().resolve()
elif _comfyui_dir:
    COMFY_INPUT_DIR = _comfyui_dir / "input"
else:
    COMFY_INPUT_DIR = INPUT_DIR

_comfy_output_env = str(os.environ.get("COMFYUI_OUTPUT_DIR", "")).strip()
if _comfy_output_env:
    COMFY_OUTPUT_DIR = Path(_comfy_output_env).expanduser().resolve()
elif _comfyui_dir:
    COMFY_OUTPUT_DIR = _comfyui_dir / "output"
else:
    COMFY_OUTPUT_DIR = OUTPUT_DIR

COMFYUI_SERVER = os.environ.get("COMFYUI_SERVER", "127.0.0.1:8188").strip()
REQUEST_TIMEOUT_SEC = float(os.environ.get("SIMPLE_VIDEO_HTTP_TIMEOUT", "60"))
MAX_PREVIEW_SCENE_COUNT = 40
_PREVIEW_CANCEL_FLAGS: set[str] = set()
_PREVIEW_CANCEL_LOCK = Lock()


def _preview_cancel_key(session_id: Optional[str], target: str) -> str:
    return f"{_safe_session_id(session_id)}::{str(target or '').strip().lower()}"


def _set_preview_cancel(session_id: Optional[str], target: str, enabled: bool) -> None:
    key = _preview_cancel_key(session_id, target)
    if not key:
        return
    with _PREVIEW_CANCEL_LOCK:
        if enabled:
            _PREVIEW_CANCEL_FLAGS.add(key)
        else:
            _PREVIEW_CANCEL_FLAGS.discard(key)


def _is_preview_cancel_requested(session_id: Optional[str], target: str) -> bool:
    key = _preview_cancel_key(session_id, target)
    if not key:
        return False
    with _PREVIEW_CANCEL_LOCK:
        return key in _PREVIEW_CANCEL_FLAGS


def _interrupt_comfyui() -> bool:
    try:
        response = requests.post(f"http://{COMFYUI_SERVER}/interrupt", timeout=REQUEST_TIMEOUT_SEC)
        return bool(response.ok)
    except Exception:
        return False
ACE_STEP_URL = os.environ.get("ACE_STEP_API_URL", "").strip().rstrip("/") or None
DEFAULT_VLM_BASE_URL = os.environ.get("VLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or "http://127.0.0.1:1234/v1"
DEFAULT_VLM_API_KEY = os.environ.get("VLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or "dummy"
DEFAULT_VLM_MODEL = os.environ.get("VLM_MODEL", "gemma-3-27b-it")
DEFAULT_OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL") or os.environ.get("VLM_BASE_URL") or "http://127.0.0.1:1234/v1"
DEFAULT_OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("VLM_API_KEY") or "dummy"
_vlm_client: AsyncOpenAI | None = None
_openai_client: AsyncOpenAI | None = None
WORKFLOW_NAMES: Dict[str, str] = {
    "character_sheet_card_v1_0": "character_sheet_card_v1.0_api.json",
    "character_sheet_card_v1_0_nobg": "character_sheet_card_v1.0_nobg_api.json",
    "ace_step_1_5_t2a": "audio_ace_step_1_5_api.json",
    "qwen_t2i_2512_lightning4": "t2i_qwen_image_2512_lightning_api.json",
    "wan22_i2v_lightning": "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-NativeComfy_api.json",
    "wan22_smooth_first2last": "video_wan2_2_14B_flf2v_s_api.json",
    "ltx23_i2v": "video_ltx2_3_i2v.json",
    "ltx23_flf": "video_ltx2_3-22b-flf-bf8.json",
    "qwen_i2i_2511_bf16_lightning4_1img": "i2i_qwen_image_edit_2511_bf16_lightning4_1img_api.json",
    "qwen_i2i_2511_bf16_lightning4_2img": "i2i_qwen_image_edit_2511_bf16_lightning4_2img_api.json",
    "qwen_i2i_2511_bf16_lightning4_3img": "i2i_qwen_image_edit_2511_bf16_lightning4_3img_api.json",
}


class ProductionStateRequest(BaseModel):
    client_session_id: Optional[str] = None
    state: Dict[str, Any] = Field(default_factory=dict)


class ProductionCancelRequest(BaseModel):
    client_session_id: Optional[str] = None
    target: str


class PreviewTranslateRequest(BaseModel):
    text: str
    target_language: str = "auto"


class PreviewTranslateResponse(BaseModel):
    original_text: str
    translated_text: str
    source_language: str
    target_language: str


class PreviewStoryGenerateRequest(BaseModel):
    idea: str
    character_context: Optional[str] = None
    world_notes: Optional[str] = None
    genre: Optional[str] = None
    scene_count: Optional[int] = 5
    target_duration_sec: Optional[int] = 30
    lyrics_enabled: bool = False
    language: str = "ja"


class PreviewStoryGenerateResponse(BaseModel):
    success: bool
    scenario_text: str
    scene_outline: List[str] = Field(default_factory=list)
    world_notes: str = ""
    elapsed_time: float = 0.0


class PreviewMusicPlanGenerateRequest(BaseModel):
    scenario_text: Optional[str] = None
    world_notes: Optional[str] = None
    character_context: Optional[str] = None
    music_prompt: Optional[str] = None
    genre: Optional[str] = None
    target_duration_sec: Optional[int] = 30
    vocal_language: str = "ja"
    bpm: Optional[int] = None
    key_signature: Optional[str] = None
    has_vocals: bool = True
    instrumental_focus: bool = False


class PreviewMusicPlanGenerateResponse(BaseModel):
    success: bool
    title: str = ""
    lyrics_text: str = ""
    music_tags: str = ""
    arrangement_notes: str = ""
    recommended_bpm: Optional[int] = None
    key_signature: str = ""
    elapsed_time: float = 0.0


class PreviewMusicGenerateRequest(BaseModel):
    client_session_id: Optional[str] = None
    tags: str
    lyrics: Optional[str] = None
    language: str = "ja"
    duration: int = 30
    bpm: Optional[int] = None
    timesignature: str = "4"
    keyscale: Optional[str] = None
    steps: int = 8
    cfg: float = 3.0
    seed: Optional[int] = None
    thinking: bool = False


class PreviewMusicGenerateResponse(BaseModel):
    success: bool
    filename: str
    subfolder: str = ""
    type: str = "output"
    media_type: str = "audio"
    preview_url: str
    backend: str = "comfyui"
    source: str = "generated"
    original_filename: str = ""
    duration_sec: float = 0.0
    elapsed_time: float = 0.0


class PreviewMusicTrimRequest(BaseModel):
    client_session_id: Optional[str] = None
    filename: str
    trim_start_sec: float = 0.0
    trim_end_sec: Optional[float] = None
    source: Optional[str] = None
    original_filename: Optional[str] = None


class PreviewScenePromptGenerateRequest(BaseModel):
    scenario_text: Optional[str] = None
    world_notes: Optional[str] = None
    lyrics_text: Optional[str] = None
    arrangement_notes: Optional[str] = None
    music_tags: Optional[str] = None
    character_context: Optional[str] = None
    scene_count: Optional[int] = 5
    target_duration_sec: Optional[int] = 30
    pipeline_preset_id: Optional[str] = None
    workflow_mode: Optional[str] = None
    language: str = "en"


class PreviewScenePromptItem(BaseModel):
    scene_index: int
    prompt: str
    duration_sec: int = 0
    lyric_excerpt: str = ""
    transition_type: str = "none"
    transition_reason: str = ""
    image: Optional[Dict[str, Any]] = None


class PreviewScenePromptGenerateResponse(BaseModel):
    success: bool
    scene_prompts: List[PreviewScenePromptItem] = Field(default_factory=list)
    elapsed_time: float = 0.0


class PreviewScenePlanGenerateRequest(BaseModel):
    scenario_text: Optional[str] = None
    lyrics_text: Optional[str] = None
    world_notes: Optional[str] = None
    arrangement_notes: Optional[str] = None
    scene_count: Optional[int] = 5
    target_duration_sec: Optional[int] = 30
    pipeline_preset_id: Optional[str] = None
    workflow_mode: Optional[str] = None


class PreviewScenePlanGenerateResponse(BaseModel):
    success: bool
    scene_count: int
    scene_durations_sec: List[int] = Field(default_factory=list)
    scene_transitions: List[str] = Field(default_factory=list)
    scene_transition_reasons: List[str] = Field(default_factory=list)
    elapsed_time: float = 0.0


class PreviewSceneImageGenerateRequest(BaseModel):
    client_session_id: Optional[str] = None
    scene_index: int = 1
    prompt: str
    input_images: List[str] = Field(default_factory=list)
    cfg: float = 1.0
    denoise: float = 1.0


class PreviewSceneVideoGenerateRequest(BaseModel):
    client_session_id: Optional[str] = None
    scene_index: int = 1
    prompt: Optional[str] = None
    image_filename: str
    end_image_filename: Optional[str] = None
    duration_sec: int = 5
    fps: int = 16
    workflow_mode: str = "auto"
    audio_off: bool = False
    negative_prompt: Optional[str] = None


class PreviewFinalMVRenderRequest(BaseModel):
    client_session_id: Optional[str] = None
    video_filenames: List[str] = Field(default_factory=list)
    clip_filename: Optional[str] = None
    audio_filename: Optional[str] = None
    fps: int = 16
    xfade_transitions: List[str] = Field(default_factory=list)
    xfade_duration: Optional[float] = 0.5


class PreviewVLMAnalyzeRequest(BaseModel):
    image_base64: str
    mode: str = "image"
    language: str = "en"
    custom_prompt: Optional[str] = None
    focus_area: Optional[str] = None


class PreviewCharacterSheetRequest(BaseModel):
    client_session_id: Optional[str] = None
    source_filename: str
    nobg: bool = False


class PreviewCharacterImageRequest(BaseModel):
    client_session_id: Optional[str] = None
    prompt: str
    input_images: List[str] = Field(default_factory=list)
    cfg: float = 1.0
    denoise: float = 1.0


class PreviewImageFitRequest(BaseModel):
    client_session_id: Optional[str] = None
    filename: str
    target_width: int = 1280
    target_height: int = 720
    mode: str = "contain_blur"
    anchor_y: float = 0.5


def _safe_session_id(session_id: Optional[str]) -> str:
    raw = str(session_id or "").strip()
    if not raw:
        return ""
    return re.sub(r"[^a-zA-Z0-9._-]", "_", raw)[:120]


def _state_file(session_id: Optional[str]) -> Path:
    safe_session_id = _safe_session_id(session_id)
    if not safe_session_id:
        return PREVIEW_STATE_FILE
    return PREVIEW_STATE_DIR / safe_session_id / "state.json"


def _preview_session_dir(session_id: Optional[str]) -> Path:
    safe_session_id = _safe_session_id(session_id)
    if not safe_session_id:
        return PREVIEW_STATE_DIR / "default"
    return PREVIEW_STATE_DIR / safe_session_id


def _preview_ref_images_dir(session_id: Optional[str]) -> Path:
    ref_dir = _preview_session_dir(session_id) / "ref_images"
    ref_dir.mkdir(parents=True, exist_ok=True)
    return ref_dir


def _preview_audio_dir(session_id: Optional[str]) -> Path:
    audio_dir = _preview_session_dir(session_id) / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    return audio_dir


def _preview_ref_index_file(session_id: Optional[str]) -> Path:
    return _preview_session_dir(session_id) / "ref_images.json"


def _read_preview_ref_index(session_id: Optional[str]) -> Dict[str, Dict[str, Any]]:
    idx_path = _preview_ref_index_file(session_id)
    if not idx_path.exists():
        return {}
    try:
        loaded = json.loads(idx_path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _write_preview_ref_index(data: Dict[str, Dict[str, Any]], session_id: Optional[str]) -> None:
    idx_path = _preview_ref_index_file(session_id)
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    idx_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _safe_name(filename: str) -> str:
    raw = Path(str(filename or "upload.bin")).name
    raw = raw.replace("..", "_").replace("/", "_").replace("\\", "_")
    return raw or "upload.bin"


def _normalize_openai_base_url(url: str) -> str:
    base = str(url or "").strip().rstrip("/")
    if not base:
        return DEFAULT_VLM_BASE_URL
    return base if base.endswith("/v1") else f"{base}/v1"


def _get_vlm_client() -> AsyncOpenAI:
    global _vlm_client
    if _vlm_client is None:
        _vlm_client = AsyncOpenAI(
            base_url=_normalize_openai_base_url(DEFAULT_VLM_BASE_URL),
            api_key=DEFAULT_VLM_API_KEY,
        )
    return _vlm_client


def _get_openai_client() -> AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        _openai_client = AsyncOpenAI(
            base_url=_normalize_openai_base_url(DEFAULT_OPENAI_BASE_URL),
            api_key=DEFAULT_OPENAI_API_KEY,
        )
    return _openai_client


def _fallback_translate_text(text: str, target_lang: str) -> str:
    src = str(text or "")
    if not src.strip():
        return ""

    ja_to_en = {
        "こんにちは": "hello",
        "ありがとう": "thank you",
        "さようなら": "goodbye",
        "おはよう": "good morning",
        "こんばんは": "good evening",
        "希望": "hope",
        "光": "light",
        "夜": "night",
        "朝": "morning",
        "空": "sky",
        "心": "heart",
    }
    en_to_ja = {
        "hello": "こんにちは",
        "thank you": "ありがとう",
        "goodbye": "さようなら",
        "good morning": "おはよう",
        "good evening": "こんばんは",
        "hope": "希望",
        "light": "光",
        "night": "夜",
        "morning": "朝",
        "sky": "空",
        "heart": "心",
    }

    out = src
    if str(target_lang or "").lower() == "en":
        for ja, en in sorted(ja_to_en.items(), key=lambda item: len(item[0]), reverse=True):
            out = out.replace(ja, en)
        out = out.replace("、", ", ").replace("。", ". ")
        out = re.sub(r"\s+", " ", out).strip()
    else:
        lowered = out.lower()
        for en, ja in sorted(en_to_ja.items(), key=lambda item: len(item[0]), reverse=True):
            lowered = lowered.replace(en, ja)
        out = lowered.replace(",", "、").replace(".", "。")
        out = re.sub(r"\s+", " ", out).strip()

    return out if out else src


def _build_story_outline(text: str, scene_count: int = 5) -> List[str]:
    raw = str(text or "").strip()
    if not raw:
        return []
    parts = [chunk.strip(" -•\t") for chunk in re.split(r"\n+|(?<=[。.!?！？])\s+", raw) if chunk and chunk.strip()]
    if not parts:
        return []
    limit = max(1, min(int(scene_count or 5), 8))
    return parts[:limit]


def _fallback_story_generate(
    idea: str,
    *,
    character_context: str = "",
    world_notes: str = "",
    genre: str = "",
    scene_count: int = 5,
    target_duration_sec: int = 30,
    lyrics_enabled: bool = False,
    language: str = "ja",
) -> str:
    idea_text = str(idea or "").strip()
    character_text = str(character_context or "").strip()
    notes_text = str(world_notes or "").strip()
    genre_text = str(genre or "").strip() or "MV"
    scenes = max(1, min(int(scene_count or 5), 8))
    duration = max(10, min(int(target_duration_sec or 30), 600))
    is_ja = str(language or "ja").lower().startswith("ja")

    if is_ja:
        lines = [
            f"ジャンル: {genre_text}",
            f"想定尺: 約{duration}秒 / 想定シーン数 {scenes}",
            f"歌詞連動: {'あり' if lyrics_enabled else 'なし'}",
            "",
            "【全体コンセプト】",
            idea_text or "未入力のため、感情の流れが伝わるMVコンセプトを補ってください。",
        ]
        if character_text:
            lines.extend(["", "【キャラクタ文脈】", character_text])
        if notes_text:
            lines.extend(["", "【世界観メモ】", notes_text])
        lines.extend([
            "",
            "【物語の流れ】",
            f"- 約{scenes}シーンを想定した大まかな流れと感情曲線を整理する",
            "- 導入 / 展開 / 見せ場 / 余韻の流れが分かるようにまとめる",
            "- この段階では各シーンの画像プロンプトまでは確定しない",
            "",
            "【音楽作成への受け渡しメモ】",
            "- 曲尺、歌詞の方向性、盛り上がり位置の参考になる感情曲線を残す",
            "- 歌詞完成後にシーン画像作成でシーンプロンプトを組み立てる前提にする",
            "",
            "【演出メモ】",
            "- 色と光の変化で感情の流れをつなぐ",
            "- キャラクタの一貫性を保ちながら、各シーンに役割を持たせる",
            "- 後続のシーン画像生成で歌詞を反映しやすい具体語を残す",
        ])
        return "\n".join(lines).strip()

    lines = [
        f"Genre: {genre_text}",
        f"Target length: about {duration} seconds across {scenes} scenes",
        f"Lyrics linkage: {'enabled' if lyrics_enabled else 'disabled'}",
        "",
        "[Overall Concept]",
        idea_text or "Expand this into a coherent music video concept with a clear emotional arc.",
    ]
    if character_text:
        lines.extend(["", "[Character Context]", character_text])
    if notes_text:
        lines.extend(["", "[World Notes]", notes_text])
    lines.extend(["", "[Scene Outline]"])
    for idx in range(scenes):
        lines.append(f"{idx + 1}. Describe the role, location, time of day, emotional shift, and visual highlight of scene {idx + 1}.")
    lines.extend([
        "",
        "[Direction Notes]",
        "- Keep visual continuity while giving each scene a clear role.",
        "- Preserve concrete words that are reusable for downstream image generation.",
        "- Use lighting and color shifts to connect the emotional progression.",
    ])
    return "\n".join(lines).strip()


def _fallback_music_plan_generate(
    *,
    scenario_text: str = "",
    world_notes: str = "",
    character_context: str = "",
    music_prompt: str = "",
    genre: str = "",
    target_duration_sec: int = 30,
    vocal_language: str = "ja",
    bpm: Optional[int] = None,
    key_signature: str = "",
    has_vocals: bool = True,
    instrumental_focus: bool = False,
) -> Dict[str, Any]:
    duration = max(10, min(int(target_duration_sec or 30), 600))
    genre_text = str(genre or "").strip() or "cinematic pop"
    language = str(vocal_language or "ja").strip().lower() or "ja"
    bpm_value = max(60, min(int(bpm), 220)) if bpm else (92 if instrumental_focus else 118)
    key_value = str(key_signature or "").strip() or ("A minor" if instrumental_focus else "C major")
    prompt_text = str(music_prompt or "").strip()
    scenario = str(scenario_text or "").strip()
    notes = str(world_notes or "").strip()
    character = str(character_context or "").strip()
    title = "夜明けのフレーム" if language.startswith("ja") else "Frame of Dawn"

    if language.startswith("ja"):
        lyrics = (
            "[Verse 1]\n"
            "静かな街に滲むライト\n"
            "まだ名前のない願いを抱いて\n"
            "こぼれた昨日を拾い集めて\n"
            "次の景色へ歩き出す\n\n"
            "[Chorus]\n"
            "夜を越えて 光のほうへ\n"
            "揺れる心ごと連れてゆこう\n"
            "君の輪郭が明日を照らす\n"
            "ほどけた夢を歌に変えて\n"
        ) if has_vocals else "インスト想定のため歌詞は未使用。フックとなる旋律モチーフを主役にする。"
        tags = f"{genre_text}, {'instrumental' if instrumental_focus else 'vocal'}, {bpm_value} bpm, {key_value}, emotional, cinematic, mv soundtrack"
        arrangement = "\n".join([
            f"- 想定尺: 約{duration}秒",
            f"- BPM: {bpm_value}",
            f"- Key: {key_value}",
            "- Aメロは抑えめ、サビで広がる構成にする",
            "- 歌詞の見せ場やシーン転換に合わせてドラムとパッドを段階的に追加する",
            "- シーン画像作成では、確定歌詞のキーフレーズを各シーンへ割り当てる",
        ])
    else:
        lyrics = (
            "[Verse 1]\n"
            "City lights are fading in the rain\n"
            "I keep a nameless hope inside my hands\n"
            "Gathering pieces of a restless night\n"
            "Walking toward a brighter frame\n\n"
            "[Chorus]\n"
            "Through the dark, into the light\n"
            "Carry every heartbeat to the dawn\n"
            "Your silhouette can guide the way\n"
            "Turn the broken dream into a song\n"
        ) if has_vocals else "Instrumental-focused plan. Use a memorable lead motif instead of lyrics."
        tags = f"{genre_text}, {'instrumental' if instrumental_focus else 'vocal'}, {bpm_value} bpm, {key_value}, emotional, cinematic, mv soundtrack"
        arrangement = "\n".join([
            f"- Target duration: about {duration} seconds",
            f"- BPM: {bpm_value}",
            f"- Key: {key_value}",
            "- Keep the verse restrained and open the chorus with wider harmony",
            "- Add rhythmic lift near scene transitions and emotional peaks",
            "- Reuse confirmed lyric phrases later in the scene image step",
        ])

    if prompt_text:
        arrangement = f"- Music direction: {prompt_text}\n{arrangement}"
    if scenario:
        arrangement = f"- Scenario reference available\n{arrangement}"
    if notes:
        arrangement = f"- World note reference available\n{arrangement}"
    if character:
        arrangement = f"- Character continuity reference available\n{arrangement}"

    return {
        "title": title,
        "lyrics_text": lyrics.strip(),
        "music_tags": tags.strip(),
        "arrangement_notes": arrangement.strip(),
        "recommended_bpm": bpm_value,
        "key_signature": key_value,
    }


def _clean_preview_prompt_line(text: str) -> str:
    cleaned = re.sub(r"^#?\d+\s*[:.)\uff1a]\s*", "", str(text or "").strip())
    cleaned = re.sub(r"\*{1,2}[^*]+\*{1,2}\s*:?\s*", "", cleaned)
    return cleaned.strip()


def _parse_preview_numbered_prompts(text: str, desired_count: Optional[int] = None) -> List[Dict[str, Any]]:
    prepared = re.sub(r"\s+(#\d+\s*[:.)\uff1a])", r"\n\1", str(text or ""))
    prompts: List[Dict[str, Any]] = []
    current_num: Optional[int] = None
    current_text = ""

    for line in prepared.splitlines():
        match = re.match(r"^(?:#|Scene\s*|Prompt\s*)?(\d+)\s*[:\.\uff09\uff1a]\s*(.*)$", line.strip(), re.IGNORECASE)
        if match:
            if current_num is not None and current_text.strip():
                prompts.append({"scene": current_num, "prompt": current_text.strip()})
            current_num = int(match.group(1))
            current_text = _clean_preview_prompt_line(match.group(2))
        elif current_num is not None and line.strip():
            cleaned = _clean_preview_prompt_line(line.strip())
            if cleaned:
                current_text = f"{current_text} {cleaned}".strip()

    if current_num is not None and current_text.strip():
        prompts.append({"scene": current_num, "prompt": current_text.strip()})

    if not prompts:
        fallback_lines = [str(line or "").strip() for line in str(text or "").splitlines() if str(line or "").strip()]
        prompts = [{"scene": idx + 1, "prompt": _clean_preview_prompt_line(line)} for idx, line in enumerate(fallback_lines)]

    prompts = [item for item in prompts if str(item.get("prompt") or "").strip()]
    prompts.sort(key=lambda item: int(item.get("scene") or 0))

    if desired_count and desired_count > 0 and prompts:
        prompts = prompts[:desired_count]
        while len(prompts) < desired_count:
            prompts.append({"scene": len(prompts) + 1, "prompt": str(prompts[-1].get("prompt") or "").strip()})

    return prompts


def _extract_lyric_units(text: str) -> List[str]:
    units: List[str] = []
    for raw_line in str(text or "").splitlines():
        line = str(raw_line or "").strip()
        if not line:
            continue
        if re.match(r"^\[[^\]]+\]$", line):
            continue
        if re.match(r"^\([^)]*\)$", line):
            continue
        units.append(line)
    return units


def _build_scene_duration_plan(scene_count: int, target_duration_sec: int) -> List[int]:
    count = max(1, min(MAX_PREVIEW_SCENE_COUNT, int(scene_count or 1)))
    total = max(count, int(target_duration_sec or count))
    base = total // count
    remainder = total % count
    return [base + (1 if idx < remainder else 0) for idx in range(count)]


def _normalize_preview_workflow_mode(workflow_mode: Optional[str]) -> str:
    return str(workflow_mode or "").strip().lower()


def _is_ltx_preview_workflow_mode(workflow_mode: Optional[str], pipeline_preset_id: Optional[str] = None) -> bool:
    mode = _normalize_preview_workflow_mode(workflow_mode)
    if mode in {"ltx", "ltx_i2v", "ltx-i2v", "ltx_flf", "ltx-flf"}:
        return True
    pipeline_text = str(pipeline_preset_id or "").strip().lower()
    return "ltx" in pipeline_text


def _preview_scene_duration_bounds(
    scene_count: int,
    target_duration_sec: int,
    *,
    workflow_mode: Optional[str] = None,
    pipeline_preset_id: Optional[str] = None,
) -> tuple[int, int]:
    count = max(1, int(scene_count or 1))
    total = max(count, int(target_duration_sec or count * 5))
    average = total / count
    min_scene_sec = max(1, min(10, int(math.floor(average * 0.55))))
    max_cap = 15 if _is_ltx_preview_workflow_mode(workflow_mode, pipeline_preset_id) else 10
    max_scene_sec = max(min_scene_sec + 1, min(max_cap, int(math.ceil(average * 1.7))))
    return min_scene_sec, max_scene_sec


def _preview_scene_count_bounds(
    target_duration_sec: int,
    *,
    workflow_mode: Optional[str] = None,
    pipeline_preset_id: Optional[str] = None,
) -> tuple[int, int, int]:
    target = max(10, min(int(target_duration_sec or 30), 600))
    is_ltx = _is_ltx_preview_workflow_mode(workflow_mode, pipeline_preset_id)
    max_scene_sec = 15 if is_ltx else 10
    min_scene_sec = 2
    preferred_scene_sec = 10 if is_ltx else 5
    min_count = max(1, int(math.ceil(target / max_scene_sec)))
    max_count = max(min_count, min(MAX_PREVIEW_SCENE_COUNT, int(math.floor(target / min_scene_sec))))
    preferred_count = max(min_count, min(max_count, int(round(target / preferred_scene_sec))))
    return min_count, max_count, preferred_count


def _fallback_preview_duration_plan(
    scene_count: int,
    target_duration_sec: int,
    min_scene_sec: int,
    max_scene_sec: int,
) -> List[int]:
    count = max(1, min(MAX_PREVIEW_SCENE_COUNT, int(scene_count or 1)))
    min_sec = max(1, int(min_scene_sec or 1))
    max_sec = max(min_sec, min(15, int(max_scene_sec or min_sec + 1)))
    base_sec = max(min_sec, min(max_sec, max(2, int(round(target_duration_sec / max(1, count))))))

    durations = [base_sec] * count
    target = int(round(float(target_duration_sec or (base_sec * count))))
    target = max(count * min_sec, min(count * max_sec, target))

    if count >= 3 and max_sec > min_sec:
        center = (count - 1) / 2.0
        for idx in range(count):
            dist = abs(idx - center)
            if dist < 0.75 and durations[idx] < max_sec:
                durations[idx] += 1
            elif dist > center * 0.8 and durations[idx] > min_sec:
                durations[idx] -= 1

    delta = target - sum(durations)
    growth_order = sorted(range(count), key=lambda i: abs(i - ((count - 1) / 2.0)))
    shrink_order = sorted(range(count), key=lambda i: abs(i - ((count - 1) / 2.0)), reverse=True)
    idx = 0
    while delta != 0:
        order = growth_order if delta > 0 else shrink_order
        target_idx = order[idx % len(order)]
        if delta > 0 and durations[target_idx] < max_sec:
            durations[target_idx] += 1
            delta -= 1
        elif delta < 0 and durations[target_idx] > min_sec:
            durations[target_idx] -= 1
            delta += 1
        idx += 1
        if idx > count * max(1, max_sec - min_sec) * 4:
            break
    return durations


def _normalize_preview_duration_plan(
    proposed: List[Any],
    scene_count: int,
    target_duration_sec: int,
    min_scene_sec: int,
    max_scene_sec: int,
) -> List[int]:
    count = max(1, min(MAX_PREVIEW_SCENE_COUNT, int(scene_count or 1)))
    min_sec = max(1, int(min_scene_sec or 1))
    max_sec = max(min_sec, min(15, int(max_scene_sec or min_sec + 1)))
    target = max(count * min_sec, min(count * max_sec, int(round(float(target_duration_sec or (5 * count))))))

    raw: List[float] = []
    for value in list(proposed or []):
        try:
            number = float(value)
        except Exception:
            continue
        if number > 0:
            raw.append(number)
    if not raw:
        return _fallback_preview_duration_plan(count, target, min_sec, max_sec)
    if len(raw) < count:
        raw.extend([raw[-1]] * (count - len(raw)))
    raw = raw[:count]

    clipped = [min(max_sec, max(min_sec, float(value))) for value in raw]
    total = sum(clipped)
    if total <= 0:
        return _fallback_preview_duration_plan(count, target, min_sec, max_sec)

    scaled = [value * target / total for value in clipped]
    floors = [int(math.floor(value)) for value in scaled]
    durations = [min(max_sec, max(min_sec, value)) for value in floors]
    remainders = [scaled[i] - floors[i] for i in range(count)]
    delta = target - sum(durations)

    while delta > 0:
        candidates = sorted(range(count), key=lambda i: (remainders[i], -i), reverse=True)
        moved = False
        for idx in candidates:
            if durations[idx] < max_sec:
                durations[idx] += 1
                delta -= 1
                moved = True
                if delta == 0:
                    break
        if not moved:
            break

    while delta < 0:
        candidates = sorted(range(count), key=lambda i: (remainders[i], i))
        moved = False
        for idx in candidates:
            if durations[idx] > min_sec:
                durations[idx] -= 1
                delta += 1
                moved = True
                if delta == 0:
                    break
        if not moved:
            break

    if sum(durations) != target:
        return _fallback_preview_duration_plan(count, target, min_sec, max_sec)
    return durations


async def _generate_preview_scene_duration_plan(
    *,
    scenario_text: str,
    lyrics_text: str,
    scene_count: int,
    target_duration_sec: int,
    workflow_mode: Optional[str] = None,
    pipeline_preset_id: Optional[str] = None,
) -> List[int]:
    count = max(1, min(int(scene_count or 1), MAX_PREVIEW_SCENE_COUNT))
    target = max(10, min(int(target_duration_sec or 30), 600))
    min_scene_sec, max_scene_sec = _preview_scene_duration_bounds(
        count,
        target,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    source_text = str(scenario_text or "").strip() or str(lyrics_text or "").strip()
    if not source_text:
        return _fallback_preview_duration_plan(count, target, min_scene_sec, max_scene_sec)

    system_prompt = (
        "You are a music-video editor deciding how long each scene should naturally last. "
        "Estimate relative scene durations from story and lyrics first, then output JSON only. "
        "Use varied values when scene characteristics differ."
    )
    user_prompt = (
        "Return JSON only in the format {\"durations\": [n1, n2, ...]}.\n"
        f"Scene count: {count}\n"
        f"Target total duration seconds: {target}\n"
        f"Allowed per-scene duration range: {min_scene_sec} to {max_scene_sec} seconds\n"
        "Task: propose natural relative durations for each scene before normalization. "
        "Longer durations fit establishing shots, emotional pauses, dance phrases, or gradual reveals. "
        "Shorter durations fit transitions, punchy beats, quick reactions, or inserts.\n\n"
        f"SCENARIO:\n{scenario_text or '(none)'}\n\n"
        f"LYRICS:\n{lyrics_text or '(none)'}"
    )

    proposed: List[Any] = []
    try:
        client = _get_openai_client()
        response = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.25,
            max_tokens=800,
            repeat_penalty=1.06,
        )) or "").strip()
        code_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.DOTALL)
        payload_text = code_match.group(1) if code_match else response
        data = json.loads(payload_text)
        if isinstance(data, dict):
            proposed = list(data.get("durations") or [])
    except Exception:
        proposed = []

    return _normalize_preview_duration_plan(proposed, count, target, min_scene_sec, max_scene_sec)


async def _generate_preview_scene_duration_plan_with_count(
    *,
    scenario_text: str,
    lyrics_text: str,
    scene_count: int,
    target_duration_sec: int,
    workflow_mode: Optional[str] = None,
    pipeline_preset_id: Optional[str] = None,
    propose_scene_count: bool = False,
) -> tuple[List[int], int]:
    requested_count = max(1, min(int(scene_count or 1), MAX_PREVIEW_SCENE_COUNT))
    target = max(10, min(int(target_duration_sec or 30), 600))
    min_count, max_count, preferred_count = _preview_scene_count_bounds(
        target,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    fallback_count = preferred_count if propose_scene_count else max(min_count, min(max_count, requested_count))
    source_text = str(scenario_text or "").strip() or str(lyrics_text or "").strip()

    if not source_text:
        min_scene_sec, max_scene_sec = _preview_scene_duration_bounds(
            fallback_count,
            target,
            workflow_mode=workflow_mode,
            pipeline_preset_id=pipeline_preset_id,
        )
        return _fallback_preview_duration_plan(fallback_count, target, min_scene_sec, max_scene_sec), fallback_count

    min_scene_sec, max_scene_sec = _preview_scene_duration_bounds(
        fallback_count,
        target,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    system_prompt = (
        "You are a music-video editor deciding natural scene count and duration balance. "
        "Estimate scene count first when needed, then output JSON only. "
        "Use longer scenes for establishing shots, emotional pauses, dance phrases, or gradual reveals."
    )
    user_prompt = (
        "Return JSON only. "
        + (
            "Use format: {\"scene_count\": N, \"durations\": [n1, n2, ...]}\n"
            if propose_scene_count else
            "Use format: {\"durations\": [n1, n2, ...]}\n"
        )
        + (
            f"Choose a natural scene count between {min_count} and {max_count}. Prefer fewer, longer scenes when the workflow is suited for long shots.\n"
            if propose_scene_count else
            f"Scene count: {fallback_count}\n"
        )
        + f"Target total duration seconds: {target}\n"
        + f"Allowed per-scene duration range: {min_scene_sec} to {max_scene_sec} seconds\n"
        + "Task: propose natural relative durations for each scene before normalization. "
          "Longer durations fit establishing shots, emotional pauses, dance phrases, or gradual reveals. "
          "Shorter durations fit transitions, punchy beats, quick reactions, or inserts.\n\n"
        + f"SCENARIO:\n{scenario_text or '(none)'}\n\n"
        + f"LYRICS:\n{lyrics_text or '(none)'}"
    )

    proposed: List[Any] = []
    proposed_scene_count: Optional[int] = None
    try:
        client = _get_openai_client()
        response = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.25,
            max_tokens=900,
            repeat_penalty=1.06,
        )) or "").strip()
        code_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.DOTALL)
        payload_text = code_match.group(1) if code_match else response
        data = json.loads(payload_text)
        if isinstance(data, dict):
            proposed = list(data.get("durations") or [])
            if propose_scene_count and data.get("scene_count") is not None:
                try:
                    proposed_scene_count = int(data.get("scene_count"))
                except Exception:
                    proposed_scene_count = None
    except Exception:
        proposed = []

    chosen_count = fallback_count
    if propose_scene_count and proposed_scene_count is not None:
        chosen_count = max(min_count, min(max_count, int(proposed_scene_count)))

    min_scene_sec, max_scene_sec = _preview_scene_duration_bounds(
        chosen_count,
        target,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    durations = _normalize_preview_duration_plan(proposed, chosen_count, target, min_scene_sec, max_scene_sec)
    return durations, chosen_count


def _pick_scene_lyric_excerpt(lyric_units: List[str], scene_index: int, scene_count: int) -> str:
    if not lyric_units:
        return ""
    count = max(1, int(scene_count or 1))
    idx = max(0, min(int(scene_index or 0), count - 1))
    start = int(round(len(lyric_units) * idx / count))
    end = int(round(len(lyric_units) * (idx + 1) / count))
    chunk = lyric_units[start:end] or lyric_units[min(start, len(lyric_units) - 1):min(start + 1, len(lyric_units))]
    return " / ".join(chunk[:2]).strip()


_PREVIEW_TRANSITION_TYPES = {"none", "cut", "crossfade", "fade_black", "flf"}


def _normalize_preview_transition_type(value: Any, *, scene_index: int = 1) -> str:
    if int(scene_index or 1) <= 1:
        return "none"
    normalized = str(value or "").strip().lower()
    return normalized if normalized in _PREVIEW_TRANSITION_TYPES else "none"


def _tokenize_scene_plan_text(text: str) -> set[str]:
    tokens = re.findall(r"[A-Za-z]{3,}|[一-龯ぁ-んァ-ヴー]{2,}", str(text or "").lower())
    return {token for token in tokens if token}


def _scene_plan_similarity(left: str, right: str) -> float:
    left_tokens = _tokenize_scene_plan_text(left)
    right_tokens = _tokenize_scene_plan_text(right)
    if not left_tokens or not right_tokens:
        return 0.0
    overlap = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    return (overlap / union) if union else 0.0


def _pipeline_supports_flf(pipeline_preset_id: str) -> bool:
    text = str(pipeline_preset_id or "").strip().lower()
    if not text:
        return True
    return any(key in text for key in ["flf", "mixed", "char", "continuous"])


def _preview_transition_rule_profile(pipeline_preset_id: str = "", workflow_mode: str = "") -> Dict[str, Any]:
    pipeline_text = str(pipeline_preset_id or "").strip().lower()
    workflow_text = str(workflow_mode or "").strip().lower()
    is_ltx = workflow_text in {"ltx", "ltx_flf", "ltx_i2v", "ltx-i2v", "ltx-flf"} or "ltx" in pipeline_text
    allow_flf = _pipeline_supports_flf(pipeline_preset_id)
    profile: Dict[str, Any] = {
        "allow_flf": allow_flf,
        "similarity_for_flf": 0.58,
        "similarity_for_crossfade": 0.28,
        "prefer_fade_black": True,
        "prefer_crossfade": True,
        "prefer_flf": allow_flf,
        "label": "balanced",
        "guidance": "Balance continuity against visible scene separation.",
    }

    if "char_edit_i2v_mixed" in pipeline_text:
        profile.update({
            "similarity_for_flf": 0.46 if is_ltx else 0.5,
            "similarity_for_crossfade": 0.24,
            "prefer_flf": allow_flf,
            "prefer_crossfade": True,
            "prefer_fade_black": True,
            "label": "character_mixed",
            "guidance": "Preserve character continuity aggressively. Use FLF often between visually similar adjacent scenes, crossfade for soft mood changes, and fade to black for major section breaks.",
        })
    elif "ext_i2i_i2v_mixed" in pipeline_text:
        profile.update({
            "similarity_for_flf": 0.72 if allow_flf else 1.0,
            "similarity_for_crossfade": 0.22,
            "prefer_flf": False,
            "prefer_crossfade": True,
            "prefer_fade_black": True,
            "label": "edit_mixed",
            "guidance": "Favor edit-friendly transitions. Prefer crossfade or fade to black, and reserve FLF only for extremely similar adjacent shots.",
        })
    elif "mixed" in pipeline_text:
        profile.update({
            "similarity_for_flf": 0.54 if is_ltx else 0.6,
            "similarity_for_crossfade": 0.24,
            "prefer_flf": allow_flf,
            "prefer_crossfade": True,
            "prefer_fade_black": True,
            "label": "generic_mixed",
            "guidance": "Use a varied transition mix: FLF for continuity, crossfade for tone shifts, and fade to black for section boundaries.",
        })
    elif "scene_cut" in pipeline_text or workflow_text == "i2v":
        profile.update({
            "similarity_for_flf": 0.8,
            "similarity_for_crossfade": 0.36,
            "prefer_flf": False,
            "prefer_crossfade": False,
            "prefer_fade_black": False,
            "label": "scene_cut",
            "guidance": "Favor hard cuts. Only use soft transitions when the adjacent shots are clearly related.",
        })
    elif "flf" in pipeline_text or workflow_text in {"flf", "ltx_flf"}:
        profile.update({
            "similarity_for_flf": 0.42 if is_ltx else 0.5,
            "similarity_for_crossfade": 0.25,
            "prefer_flf": allow_flf,
            "prefer_crossfade": True,
            "prefer_fade_black": False,
            "label": "flf_continuous",
            "guidance": "Favor continuity. Use FLF whenever adjacent scenes feel like the same ongoing shot or motion phrase.",
        })

    return profile


def _build_transition_reason_text(
    transition: str,
    *,
    similarity: float,
    min_duration: int,
    max_duration: int,
    progress: float,
    profile_label: str,
) -> str:
    if transition == "none":
        return "先頭シーンのため遷移なし"
    if transition == "cut":
        if min_duration <= 2:
            return f"短尺境界のためテンポ優先（{min_duration}s）"
        return f"場面差が大きいためカット（類似度 {similarity:.2f}）"
    if transition == "crossfade":
        return f"雰囲気を保って接続（類似度 {similarity:.2f} / {profile_label}）"
    if transition == "fade_black":
        section = "サビ・章切替" if 0.42 <= progress <= 0.78 else "強い場面転換"
        return f"{section}として暗転（類似度 {similarity:.2f}）"
    if transition == "flf":
        return f"連続性が高いため FLF（類似度 {similarity:.2f} / {max_duration}s）"
    return "自動提案"


def _heuristic_scene_transition_plan_with_reasons(
    *,
    scene_count: int,
    scenario_text: str = "",
    lyrics_text: str = "",
    world_notes: str = "",
    arrangement_notes: str = "",
    durations: Optional[List[int]] = None,
    pipeline_preset_id: str = "",
    workflow_mode: str = "",
) -> tuple[List[str], List[str]]:
    count = max(1, int(scene_count or 1))
    outline = _build_story_outline(scenario_text, count)
    lyric_units = _extract_lyric_units(lyrics_text)
    resolved_durations = list(durations or _build_scene_duration_plan(count, count * 5))[:count]
    while len(resolved_durations) < count:
        resolved_durations.append(5)

    profile = _preview_transition_rule_profile(pipeline_preset_id, workflow_mode)
    allow_flf = bool(profile.get("allow_flf"))
    flf_similarity = float(profile.get("similarity_for_flf") or 0.58)
    crossfade_similarity = float(profile.get("similarity_for_crossfade") or 0.28)
    prefer_fade_black = bool(profile.get("prefer_fade_black"))
    prefer_crossfade = bool(profile.get("prefer_crossfade"))
    prefer_flf = bool(profile.get("prefer_flf"))
    profile_label = str(profile.get("label") or "balanced")

    transitions: List[str] = ["none"]
    reasons: List[str] = ["先頭シーンのため遷移なし"]
    notes_text = str(world_notes or "").strip()
    arrangement_text = str(arrangement_notes or "").strip().lower()
    has_chorus_cue = "サビ" in arrangement_text or "chorus" in arrangement_text or "drop" in arrangement_text

    for idx in range(1, count):
        previous_summary = outline[idx - 1] if idx - 1 < len(outline) else ""
        current_summary = outline[idx] if idx < len(outline) else previous_summary
        previous_lyric = _pick_scene_lyric_excerpt(lyric_units, idx - 1, count)
        current_lyric = _pick_scene_lyric_excerpt(lyric_units, idx, count)
        previous_text = " ".join(filter(None, [previous_summary, previous_lyric, notes_text]))
        current_text = " ".join(filter(None, [current_summary, current_lyric, notes_text]))
        similarity = _scene_plan_similarity(previous_text, current_text)
        min_duration = min(resolved_durations[idx - 1], resolved_durations[idx])
        max_duration = max(resolved_durations[idx - 1], resolved_durations[idx])
        progress = idx / max(1, count - 1)

        if min_duration <= 2:
            transition = "cut"
        elif prefer_fade_black and has_chorus_cue and 0.42 <= progress <= 0.78 and similarity < 0.34:
            transition = "fade_black"
        elif allow_flf and prefer_flf and similarity >= flf_similarity and max_duration >= 4:
            transition = "flf"
        elif prefer_crossfade and similarity >= crossfade_similarity:
            transition = "crossfade"
        elif allow_flf and similarity >= max(flf_similarity + 0.08, 0.7) and max_duration >= 5:
            transition = "flf"
        elif prefer_fade_black and similarity < 0.18 and progress > 0.2:
            transition = "fade_black"
        elif similarity >= max(crossfade_similarity - 0.04, 0.2):
            transition = "crossfade"
        else:
            transition = "cut"

        normalized = _normalize_preview_transition_type(transition, scene_index=idx + 1)
        transitions.append(normalized)
        reasons.append(_build_transition_reason_text(
            normalized,
            similarity=similarity,
            min_duration=min_duration,
            max_duration=max_duration,
            progress=progress,
            profile_label=profile_label,
        ))

    return transitions[:count], reasons[:count]


def _heuristic_scene_transition_plan(
    *,
    scene_count: int,
    scenario_text: str = "",
    lyrics_text: str = "",
    world_notes: str = "",
    arrangement_notes: str = "",
    durations: Optional[List[int]] = None,
    pipeline_preset_id: str = "",
    workflow_mode: str = "",
) -> List[str]:
    transitions, _ = _heuristic_scene_transition_plan_with_reasons(
        scene_count=scene_count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )
    return transitions


def _build_scene_transition_plan(
    *,
    scene_count: int,
    scenario_text: str = "",
    lyrics_text: str = "",
    world_notes: str = "",
    arrangement_notes: str = "",
    durations: Optional[List[int]] = None,
    pipeline_preset_id: str = "",
    workflow_mode: str = "",
) -> tuple[List[str], List[str]]:
    return _heuristic_scene_transition_plan_with_reasons(
        scene_count=scene_count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )


async def _generate_preview_scene_transition_plan(
    *,
    scene_count: int,
    scenario_text: str = "",
    lyrics_text: str = "",
    world_notes: str = "",
    arrangement_notes: str = "",
    durations: Optional[List[int]] = None,
    pipeline_preset_id: str = "",
    workflow_mode: str = "",
) -> tuple[List[str], List[str]]:
    count = max(1, int(scene_count or 1))
    fallback, fallback_reasons = _heuristic_scene_transition_plan_with_reasons(
        scene_count=count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )
    source_text = "\n".join(filter(None, [str(scenario_text or "").strip(), str(lyrics_text or "").strip(), str(world_notes or "").strip(), str(arrangement_notes or "").strip()]))
    if not source_text:
        return fallback, fallback_reasons

    resolved_durations = list(durations or [])[:count]
    while len(resolved_durations) < count:
        resolved_durations.append(5)
    lyric_units = _extract_lyric_units(lyrics_text)
    outline = _build_story_outline(scenario_text, count)
    profile = _preview_transition_rule_profile(pipeline_preset_id, workflow_mode)
    allowed = ["none", "cut", "crossfade", "fade_black"]
    if profile.get("allow_flf"):
        allowed.append("flf")
    scene_lines = []
    for idx in range(count):
        scene_lines.append(
            f"#{idx + 1}: duration={resolved_durations[idx]}s | outline={outline[idx] if idx < len(outline) else '(none)'} | lyric={_pick_scene_lyric_excerpt(lyric_units, idx, count) or '(none)'}"
        )

    system_prompt = (
        "You are a music-video editor choosing scene-to-scene transitions. "
        "Return JSON only. Prefer consistent, production-ready transition choices."
    )
    user_prompt = (
        "Return JSON only in the format {\"transitions\": [t1, t2, ...], \"reasons\": [r1, r2, ...]}.\n"
        f"Scene count: {count}\n"
        f"Allowed transitions: {', '.join(allowed)}\n"
        f"Pipeline guidance: {str(profile.get('guidance') or '')}\n"
        "Rules:\n"
        "- First scene must always be 'none'.\n"
        "- First reason must mention that the first scene has no transition.\n"
        "- Use 'flf' only when adjacent scenes feel like the same continuous shot or very similar setup.\n"
        "- Use 'crossfade' for gentle mood/pose/location shifts.\n"
        "- Use 'fade_black' for clear section boundaries, dramatic resets, or strong lyrical pivots.\n"
        "- Use 'cut' for punchy edits, contrast, or low continuity.\n\n"
        f"WORLD_NOTES:\n{world_notes or '(none)'}\n\n"
        f"ARRANGEMENT_NOTES:\n{arrangement_notes or '(none)'}\n\n"
        f"SCENES:\n{'\n'.join(scene_lines)}"
    )

    try:
        client = _get_openai_client()
        response = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.2,
            max_tokens=900,
            repeat_penalty=1.05,
        )) or "").strip()
        code_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.DOTALL)
        payload_text = code_match.group(1) if code_match else response
        data = json.loads(payload_text)
        proposed = list(data.get("transitions") or []) if isinstance(data, dict) else []
        proposed_reasons = list(data.get("reasons") or []) if isinstance(data, dict) else []
        normalized = [
            _normalize_preview_transition_type(proposed[idx] if idx < len(proposed) else fallback[idx], scene_index=idx + 1)
            for idx in range(count)
        ]
        if len(normalized) != count:
            return fallback, fallback_reasons
        reasons = [
            str(proposed_reasons[idx] or "").strip() if idx < len(proposed_reasons) else fallback_reasons[idx]
            for idx in range(count)
        ]
        reasons = [reason or fallback_reasons[idx] for idx, reason in enumerate(reasons)]
        return normalized, reasons
    except Exception:
        return fallback, fallback_reasons


def _fallback_scene_prompt_generate(
    *,
    scenario_text: str = "",
    world_notes: str = "",
    lyrics_text: str = "",
    arrangement_notes: str = "",
    music_tags: str = "",
    character_context: str = "",
    scene_count: int = 5,
    target_duration_sec: int = 30,
    pipeline_preset_id: str = "",
    workflow_mode: str = "",
) -> List[Dict[str, Any]]:
    outline = _build_story_outline(scenario_text, scene_count)
    lyric_units = _extract_lyric_units(lyrics_text)
    min_scene_sec, max_scene_sec = _preview_scene_duration_bounds(
        scene_count,
        target_duration_sec,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    durations = _fallback_preview_duration_plan(scene_count, target_duration_sec, min_scene_sec, max_scene_sec)
    transitions, transition_reasons = _build_scene_transition_plan(
        scene_count=scene_count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )
    notes_text = str(world_notes or "").strip()
    arrangement_text = str(arrangement_notes or "").strip()
    tags_text = str(music_tags or "").strip()
    character_text = str(character_context or "").strip()

    items: List[Dict[str, Any]] = []
    for idx in range(scene_count):
        scene_summary = outline[idx] if idx < len(outline) else (outline[-1] if outline else f"Scene {idx + 1}")
        lyric_excerpt = _pick_scene_lyric_excerpt(lyric_units, idx, scene_count)
        prompt_parts = [
            "cinematic anime music video still",
            "single full-frame composition",
            str(scene_summary or "").strip(),
        ]
        if lyric_excerpt:
            prompt_parts.append(f"lyric motif: {lyric_excerpt}")
        if notes_text:
            prompt_parts.append(notes_text)
        if arrangement_text:
            prompt_parts.append(arrangement_text)
        if tags_text:
            prompt_parts.append(tags_text)
        if character_text:
            prompt_parts.append(character_text)
        prompt_parts.extend([
            "coherent character identity",
            "strong lighting and color contrast",
            "detailed background",
            "no text, no logo, no split screen, no duplicate character",
        ])
        items.append(
            {
                "scene_index": idx + 1,
                "prompt": ", ".join([part for part in prompt_parts if str(part or "").strip()]),
                "duration_sec": durations[idx],
                "lyric_excerpt": lyric_excerpt,
                "transition_type": transitions[idx] if idx < len(transitions) else _normalize_preview_transition_type("none", scene_index=idx + 1),
                "transition_reason": transition_reasons[idx] if idx < len(transition_reasons) else "",
            }
        )
    return items


def _sanitize_preview_ace_step_lyrics(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return raw

    def _canonicalize_section_tag(line: str) -> Optional[str]:
        match = re.match(r"^\s*\[([^\]]+)\]\s*$", str(line or ""))
        if not match:
            return None
        inner = str(match.group(1) or "").strip()
        base = re.split(r"\s+-\s+|\s*:\s*|\s*/\s*", inner, maxsplit=1)[0].strip()
        norm = re.sub(r"\s+", " ", base).lower().replace("pre chorus", "pre-chorus")
        mapping = {
            "intro": "[Intro]",
            "instrumental": "[Instrumental]",
            "inst": "[Instrumental]",
            "verse 1": "[Verse 1]",
            "verse1": "[Verse 1]",
            "verse 2": "[Verse 2]",
            "verse2": "[Verse 2]",
            "pre-chorus": "[Pre-Chorus]",
            "prechorus": "[Pre-Chorus]",
            "chorus": "[Chorus]",
            "hook": "[Chorus]",
            "bridge": "[Bridge]",
            "outro": "[Outro]",
        }
        return mapping.get(norm)

    out_lines: List[str] = []
    for line in raw.splitlines():
        stripped = str(line or "").strip()
        if not stripped:
            out_lines.append("")
            continue
        canonical = _canonicalize_section_tag(stripped)
        if canonical:
            out_lines.append(canonical)
            continue
        if re.match(r"^\((?:intro|outro|instrumental|piano|guitar|strings|synth|drums?|ambient)[^)]*\)$", stripped, re.IGNORECASE):
            continue
        out_lines.append(stripped)

    result = "\n".join(out_lines).strip()
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result


def _normalize_music_key_signature(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    cleaned = raw.replace("♯", "#").replace("♭", "b")
    cleaned = re.sub(r"\(.*?\)", "", cleaned).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)

    match = re.search(r"\b([A-G])\s*([#b]?)(?:\s*(major|minor|maj|min|m))\b", cleaned, flags=re.IGNORECASE)
    if match:
        note = match.group(1).upper()
        accidental = match.group(2) or ""
        quality = (match.group(3) or "").lower()
        if quality in {"maj", "major"}:
            return f"{note}{accidental} major"
        if quality in {"min", "minor", "m"}:
            return f"{note}{accidental} minor"

    match = re.search(r"\b([A-G])\s*([#b]?)\b", cleaned, flags=re.IGNORECASE)
    if match:
        note = match.group(1).upper()
        accidental = match.group(2) or ""
        lowered = cleaned.lower()
        quality = "minor" if "minor" in lowered or re.search(r"\bm\b", lowered) else "major"
        return f"{note}{accidental} {quality}"

    return cleaned[:32]


def _apply_music_generation_parameters(
    workflow: Dict[str, Any],
    *,
    tags: str,
    lyrics: str,
    language: str,
    duration: int,
    bpm: Optional[int],
    timesignature: str,
    keyscale: Optional[str],
    steps: int,
    cfg: float,
    seed: Optional[int],
) -> None:
    resolved_seed = seed if isinstance(seed, int) and seed > 0 else random.SystemRandom().randint(1, 2_147_483_647)
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        _set_if_present(inputs, ["lyrics"], lyrics)
        _set_if_present(inputs, ["tags", "caption", "prompt"], tags)
        _set_if_present(inputs, ["language"], language)
        _set_if_present(inputs, ["audio_duration", "duration", "seconds"], duration)
        _set_if_present(inputs, ["bpm"], bpm)
        _set_if_present(inputs, ["timesignature"], timesignature)
        _set_if_present(inputs, ["keyscale"], keyscale)
        _set_if_present(inputs, ["steps"], steps)
        _set_if_present(inputs, ["cfg", "cfg_scale", "guidance"], cfg)
        _set_if_present(inputs, ["seed", "noise_seed"], resolved_seed)


def _generate_music_audio_via_comfy(
    *,
    client_session_id: Optional[str],
    tags: str,
    lyrics: str,
    language: str,
    duration: int,
    bpm: Optional[int],
    timesignature: str,
    keyscale: Optional[str],
    steps: int,
    cfg: float,
    seed: Optional[int],
) -> Dict[str, Any]:
    del client_session_id  # reserved for future per-session output handling
    workflow_name = "ace_step_1_5_t2a"
    workflow = _load_workflow(workflow_name)
    _apply_music_generation_parameters(
        workflow,
        tags=tags,
        lyrics=lyrics,
        language=language,
        duration=duration,
        bpm=bpm,
        timesignature=timesignature,
        keyscale=keyscale,
        steps=steps,
        cfg=cfg,
        seed=seed,
    )
    prompt_id = _queue_prompt_to_comfyui(workflow)
    deadline = time.time() + 900
    outputs: List[Dict[str, Any]] = []
    used_recent_fallback = False
    while time.time() < deadline:
        try:
            history = _fetch_history(prompt_id)
            outputs = _extract_outputs(history, prompt_id)
        except Exception:
            outputs = []
        if not outputs:
            try:
                history_all = _fetch_history_all()
                outputs = _extract_outputs(history_all, prompt_id)
            except Exception:
                outputs = []
        if any(str(item.get("media_type")) == "audio" for item in outputs):
            break
        time.sleep(1.5)

    if not outputs:
        raise RuntimeError("Music generation timed out")

    selected = next((item for item in outputs if str(item.get("media_type")) == "audio"), outputs[0])
    return {
        "filename": str(selected.get("filename") or ""),
        "subfolder": str(selected.get("subfolder") or ""),
        "type": str(selected.get("type") or "output"),
        "media_type": str(selected.get("media_type") or "audio"),
        "backend": "comfyui",
        "prompt_id": prompt_id,
    }


def _generate_music_audio_via_ace_step_api(
    *,
    tags: str,
    lyrics: str,
    language: str,
    duration: int,
    bpm: Optional[int],
    timesignature: str,
    keyscale: Optional[str],
    steps: int,
    cfg: float,
    seed: Optional[int],
    thinking: bool,
) -> Dict[str, Any]:
    if not ACE_STEP_URL:
        raise RuntimeError("ACE-Step API is not configured")

    payload: Dict[str, Any] = {
        "prompt": tags,
        "lyrics": lyrics,
        "thinking": bool(thinking),
        "vocal_language": language,
        "audio_duration": int(duration),
        "time_signature": str(timesignature),
        "batch_size": 1,
        "audio_format": "mp3",
        "inference_steps": int(steps),
        "guidance_scale": float(cfg),
    }
    if bpm is not None:
        payload["bpm"] = int(bpm)
    if keyscale:
        payload["key_scale"] = str(keyscale)
    if seed is not None:
        payload["seed"] = int(seed)

    try:
        response = requests.post(f"{ACE_STEP_URL}/release_task", json=payload, timeout=REQUEST_TIMEOUT_SEC)
    except Exception as exc:
        raise RuntimeError(f"ACE-Step API connection error: {exc}") from exc
    if not response.ok:
        raise RuntimeError(f"ACE-Step API release_task failed: HTTP {response.status_code} {response.text[:300]}")

    task_id = str((response.json().get("data") or {}).get("task_id") or "").strip()
    if not task_id:
        raise RuntimeError("ACE-Step API did not return task_id")

    deadline = time.time() + 900
    while time.time() < deadline:
        poll_response = requests.post(
            f"{ACE_STEP_URL}/query_result",
            json={"task_id_list": [task_id]},
            timeout=30,
        )
        if poll_response.ok:
            data_list = poll_response.json().get("data", []) or []
            if data_list:
                task_data = data_list[0] or {}
                status = int(task_data.get("status", 0) or 0)
                if status == 1:
                    result_json = task_data.get("result", "[]")
                    results = json.loads(result_json) if isinstance(result_json, str) else result_json
                    audio_dir = OUTPUT_DIR / "audio"
                    audio_dir.mkdir(parents=True, exist_ok=True)
                    for item in (results if isinstance(results, list) else [results]):
                        file_path = str((item or {}).get("file") or "").strip()
                        if not file_path:
                            continue
                        audio_url = f"{ACE_STEP_URL}{file_path}"
                        local_name = f"ace_step_{task_id}_{Path(file_path).name}"
                        local_path = audio_dir / local_name
                        download_response = requests.get(audio_url, timeout=60)
                        if download_response.ok:
                            local_path.write_bytes(download_response.content)
                            return {
                                "filename": local_name,
                                "subfolder": "audio",
                                "type": "output",
                                "media_type": "audio",
                                "backend": "ace-step-api",
                                "prompt_id": task_id,
                            }
                    raise RuntimeError("ACE-Step API finished but no audio file could be downloaded")
                if status == 2:
                    error_msg = task_data.get("result", "Unknown error")
                    raise RuntimeError(f"ACE-Step API generation failed: {error_msg}")
        time.sleep(3.0)

    raise RuntimeError("ACE-Step API generation timed out")


def _fallback_vlm_description(image_base64: str, mode: str, language: str, focus_area: Optional[str] = None) -> str:
    raw = str(image_base64 or "")
    mime = "image"
    est_size = 0
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", raw, re.DOTALL)
    payload = raw
    if match:
        mime = match.group(1)
        payload = match.group(2)
    try:
        est_size = len(base64.b64decode(payload, validate=False))
    except Exception:
        est_size = 0

    focus_note = f" Focus area: {focus_area.strip()}." if str(focus_area or "").strip() else ""
    if str(language or "en").lower().startswith("ja"):
        return (
            f"{mime} 参照画像（約{est_size}バイト）を基にした説明です。"
            "主題、衣装、髪型、色、構図、光、背景、雰囲気を整理し、"
            "後続の画像生成やキャラクタ設計へ転用しやすい形で要約してください。"
            f"{focus_note}"
        )
    return (
        f"Detailed {mime} reference (about {est_size} bytes). "
        "Describe subject identity, outfit, hair, color palette, composition, lighting, background, and mood in a reusable prompt style."
        f"{focus_note}"
    )


def _workflow_file_from_name(name: str) -> Path:
    candidate = WORKFLOW_NAMES.get(name, name)
    workflow_file = WORKFLOWS_DIR / str(candidate)
    if workflow_file.exists():
        return workflow_file
    raise HTTPException(status_code=400, detail=f"Unknown workflow: {name}")


def _load_workflow(workflow: str) -> Dict[str, Any]:
    with open(_workflow_file_from_name(workflow), "r", encoding="utf-8") as file_obj:
        return json.load(file_obj)


def _set_if_present(inputs: Dict[str, Any], keys: List[str], value: Any) -> None:
    if value is None:
        return
    for key in keys:
        if key in inputs:
            inputs[key] = value


def _wrap_qwen_2511_edit_instruction_prompt(text: str) -> str:
    body = str(text or "").strip()
    if not body:
        return ""
    if re.search(r"picture\s*1|画像\s*1|in\s+picture\s*1|edit\s+picture\s*1", body, re.IGNORECASE):
        return body
    return "\n".join(
        [
            "Edit picture 1 according to the instruction below.",
            "Preserve the subject identity and overall composition, but apply the edits clearly.",
            body,
        ]
    )


def _resolve_qwen_2511_workflow_variant(input_count: int) -> str:
    if input_count <= 1:
        return "qwen_i2i_2511_bf16_lightning4_1img"
    if input_count == 2:
        return "qwen_i2i_2511_bf16_lightning4_2img"
    return "qwen_i2i_2511_bf16_lightning4_3img"


def _apply_basic_parameters(
    workflow: Dict[str, Any],
    *,
    input_images: Optional[List[str]] = None,
    prompt: Optional[str] = None,
    negative_prompt: Optional[str] = None,
    cfg: Optional[float] = None,
    denoise: Optional[float] = None,
    fps: Optional[int] = None,
    frames: Optional[int] = None,
    seed: Optional[int] = None,
    steps: Optional[int] = None,
) -> None:
    normalized_images = [str(item).strip() for item in (input_images or []) if str(item).strip()]
    image_index = 0
    resolved_seed = seed if isinstance(seed, int) and seed > 0 else random.SystemRandom().randint(1, 2_147_483_647)

    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        _set_if_present(inputs, ["text", "prompt", "caption", "tags"], prompt)
        _set_if_present(inputs, ["negative_prompt", "negative_text"], negative_prompt)
        if "negative" in inputs and isinstance(inputs.get("negative"), str) and negative_prompt is not None:
            inputs["negative"] = negative_prompt
        _set_if_present(inputs, ["cfg", "cfg_scale", "guidance"], cfg)
        _set_if_present(inputs, ["denoise", "strength"], denoise)
        _set_if_present(inputs, ["fps", "frame_rate"], fps)
        _set_if_present(inputs, ["frames", "length", "num_frames", "frames_number"], frames)
        _set_if_present(inputs, ["steps"], steps)
        _set_if_present(inputs, ["seed", "noise_seed"], resolved_seed)

        class_type = str(node.get("class_type", ""))

        if class_type == "WanFirstLastFrameToVideo":
            resolved_fps = max(1, int(fps or 16))
            resolved_frames = max(1, int(frames or (resolved_fps * 5 + 1)))
            if not isinstance(inputs.get("width"), int) or int(inputs.get("width") or 0) <= 0:
                inputs["width"] = 1280
            if not isinstance(inputs.get("height"), int) or int(inputs.get("height") or 0) <= 0:
                inputs["height"] = 720
            if not isinstance(inputs.get("length"), int) or int(inputs.get("length") or 0) <= 0:
                inputs["length"] = resolved_frames
            if not isinstance(inputs.get("batch_size"), int) or int(inputs.get("batch_size") or 0) <= 0:
                inputs["batch_size"] = 1

        if class_type == "LoadImage" and image_index < len(normalized_images):
            _set_if_present(inputs, ["image"], normalized_images[image_index])
            image_index += 1


def _resolve_preview_scene_video_workflow(workflow_mode: str, has_end_image: bool) -> str:
    mode = str(workflow_mode or "auto").strip().lower()
    if mode in {"ltx", "ltx_i2v", "ltx-i2v"}:
        return "ltx23_i2v"
    if mode in {"ltx_flf", "ltx-flf"}:
        return "ltx23_flf" if has_end_image else "ltx23_i2v"
    if mode == "flf" and has_end_image:
        return "wan22_smooth_first2last"
    if mode == "i2v":
        return "wan22_i2v_lightning"
    if has_end_image and mode in {"auto", "mixed"}:
        return "wan22_smooth_first2last"
    return "wan22_i2v_lightning"


def _default_preview_scene_video_fps(workflow_mode: str) -> int:
    mode = str(workflow_mode or "auto").strip().lower()
    return 25 if mode in {"ltx", "ltx_i2v", "ltx-i2v", "ltx_flf", "ltx-flf"} else 16


def _disable_ltx_workflow_audio(workflow: Dict[str, Any]) -> None:
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        if str(node.get("class_type") or "") != "CreateVideo":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        inputs.pop("audio", None)


def _build_preview_scene_video_negative_prompt() -> str:
    return (
        "blurry, low quality, still frame, freeze frame, duplicate character, text, subtitle, logo, watermark, "
        "split screen, collage, broken anatomy, deformed hands, extra limbs, jittery motion"
    )


def _scene_video_frame_count(duration_sec: int, fps: int) -> int:
    resolved_fps = max(8, min(int(fps or 16), 32))
    resolved_duration = max(1, min(int(duration_sec or 5), 15))
    return max(17, min(resolved_fps * resolved_duration + 1, 241))


def _run_preview_ffmpeg(cmd: List[str]) -> None:
    final_cmd = list(cmd)
    if "-hide_banner" not in final_cmd:
        final_cmd.insert(1, "-hide_banner")
    if "-loglevel" not in final_cmd:
        final_cmd.insert(2, "-loglevel")
        final_cmd.insert(3, "error")

    proc = subprocess.run(final_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        stderr_text = str(proc.stderr or "").strip()
        if stderr_text:
            lines = stderr_text.splitlines()
            if len(lines) > 40:
                stderr_text = "\n".join(lines[-40:])
        raise RuntimeError(stderr_text or "ffmpeg failed")


def _probe_preview_media_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        stderr_text = str(result.stderr or "").strip()
        raise RuntimeError(stderr_text or f"ffprobe failed for {path.name}")
    try:
        return max(0.0, float(str(result.stdout or "").strip() or 0.0))
    except Exception as exc:
        raise RuntimeError(f"Could not read duration for {path.name}: {exc}") from exc


def _trim_preview_audio_segment(
    source_path: Path,
    *,
    client_session_id: Optional[str],
    trim_start_sec: float = 0.0,
    trim_end_sec: Optional[float] = None,
) -> tuple[Path, float]:
    source_duration = max(0.0, _probe_preview_media_duration(source_path))
    resolved_start = max(0.0, float(trim_start_sec or 0.0))
    resolved_end = source_duration if trim_end_sec is None else min(source_duration, max(0.0, float(trim_end_sec or 0.0)))
    if not math.isfinite(resolved_start) or not math.isfinite(resolved_end):
        raise RuntimeError("trim range must be finite")
    if source_duration <= 0.05:
        raise RuntimeError("source audio duration is invalid")
    if resolved_start >= source_duration - 0.05:
        raise RuntimeError("trim start must be earlier than audio end")
    if resolved_end <= resolved_start + 0.05:
        raise RuntimeError("trim end must be later than trim start")

    safe_stem = Path(_safe_name(source_path.stem or "audio")).stem or "audio"
    output_path = _preview_audio_dir(client_session_id) / f"{safe_stem}_trim_{uuid.uuid4().hex[:8]}.mp3"
    try:
        _run_preview_ffmpeg([
            "ffmpeg",
            "-y",
            "-ss",
            f"{resolved_start:.3f}",
            "-to",
            f"{resolved_end:.3f}",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(output_path),
        ])
        trimmed_duration = round(_probe_preview_media_duration(output_path), 2)
    except Exception:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise
    return output_path, trimmed_duration


def _build_preview_media_payload(path: Path, client_session_id: Optional[str], media_type: str) -> Dict[str, Any]:
    subfolder = ""
    try:
        subfolder = str(path.parent.relative_to(OUTPUT_DIR)).replace("\\", "/")
        if subfolder == ".":
            subfolder = ""
    except Exception:
        subfolder = ""
    return {
        "filename": path.name,
        "subfolder": subfolder,
        "type": "output",
        "media_type": media_type,
        "preview_url": (
            f"/api/v1/production/media/{_safe_name(path.name)}"
            f"?client_session_id={_safe_session_id(client_session_id)}"
            f"&subfolder={subfolder}"
            f"&type=output"
        ),
    }


def _escape_preview_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", r"'\''")


def _concat_preview_videos(
    video_paths: List[Path],
    *,
    fps: int,
    xfade_transitions: Optional[List[str]] = None,
    xfade_duration: Optional[float] = 0.5,
) -> Path:
    if not video_paths:
        raise RuntimeError("No scene videos were provided")

    durations = [_probe_preview_media_duration(path) for path in video_paths]
    invalid = [path.name for path, duration in zip(video_paths, durations) if duration <= 0.05]
    if invalid:
        raise RuntimeError(f"Invalid scene video duration: {', '.join(invalid)}")

    out_dir = OUTPUT_DIR / "movie"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"production_concat_{stamp}_{uuid.uuid4().hex[:6]}.mp4"

    if len(video_paths) == 1:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(video_paths[0]),
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-r",
            str(max(1, int(fps or 16))),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(out_path),
        ]
        _run_preview_ffmpeg(cmd)
        return out_path

    normalized_transitions = [str(item or "").strip().lower() for item in (xfade_transitions or [])]
    boundary_count = max(0, len(video_paths) - 1)
    if len(normalized_transitions) < boundary_count:
        normalized_transitions.extend([""] * (boundary_count - len(normalized_transitions)))
    normalized_transitions = normalized_transitions[:boundary_count]
    use_xfade = any(item in {"dissolve", "fadeblack", "fade", "wipeleft", "wiperight", "slideleft", "slideright"} for item in normalized_transitions)

    if use_xfade:
        resolved_fps = max(1, int(fps or 16))
        resolved_xfade_duration = max(0.05, min(float(xfade_duration or 0.5), 2.0))
        cmd = ["ffmpeg", "-y"]
        for path in video_paths:
            cmd.extend(["-i", str(path)])

        filter_parts: List[str] = []
        for idx in range(len(video_paths)):
            filter_parts.append(f"[{idx}:v]fps={resolved_fps},format=yuv420p,setsar=1[v{idx}]")

        timeline_duration = durations[0]
        output_label = "[v0]"
        for idx in range(boundary_count):
            trans = normalized_transitions[idx] if idx < len(normalized_transitions) else ""
            effect = trans if trans in {"dissolve", "fadeblack", "fade", "wipeleft", "wiperight", "slideleft", "slideright"} else "fade"
            duration = resolved_xfade_duration if trans else 0.05
            duration = min(duration, max(0.05, durations[idx]), max(0.05, durations[idx + 1]))
            offset = max(0.0, timeline_duration - duration)
            next_label = f"[vx{idx + 1}]"
            filter_parts.append(
                f"{output_label}[v{idx + 1}]xfade=transition={effect}:duration={duration:.3f}:offset={offset:.3f}{next_label}"
            )
            output_label = next_label
            timeline_duration = timeline_duration + durations[idx + 1] - duration

        cmd.extend([
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            output_label,
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-r",
            str(resolved_fps),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(out_path),
        ])
        _run_preview_ffmpeg(cmd)
        return out_path

    list_path = out_dir / f"production_concat_{uuid.uuid4().hex[:8]}.txt"
    try:
        content = "".join(f"file '{_escape_preview_concat_path(path)}'\n" for path in video_paths)
        list_path.write_text(content, encoding="utf-8")
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-r",
            str(max(1, int(fps or 16))),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(out_path),
        ]
        _run_preview_ffmpeg(cmd)
        return out_path
    finally:
        list_path.unlink(missing_ok=True)


def _merge_preview_video_with_audio(video_path: Path, audio_path: Path) -> Path:
    out_dir = OUTPUT_DIR / "movie"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"production_final_{stamp}_{uuid.uuid4().hex[:6]}.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        str(out_path),
    ]
    _run_preview_ffmpeg(cmd)
    return out_path


def _queue_prompt_to_comfyui(workflow: Dict[str, Any]) -> str:
    url = f"http://{COMFYUI_SERVER}/prompt"
    response = requests.post(url, json={"prompt": workflow}, timeout=REQUEST_TIMEOUT_SEC)
    if not response.ok:
        detail = str(response.text or "").strip()
        if detail:
            detail = f" | response={detail[:800]}"
        raise RuntimeError(f"ComfyUI /prompt failed: HTTP {response.status_code}{detail}")
    prompt_id = response.json().get("prompt_id")
    if not prompt_id:
        raise RuntimeError("ComfyUI did not return prompt_id")
    return str(prompt_id)


def _fetch_history(prompt_id: str) -> Dict[str, Any]:
    response = requests.get(f"http://{COMFYUI_SERVER}/history/{prompt_id}", timeout=REQUEST_TIMEOUT_SEC)
    response.raise_for_status()
    return response.json() if response.content else {}

def _fetch_history_all() -> Dict[str, Any]:
    response = requests.get(f"http://{COMFYUI_SERVER}/history", timeout=REQUEST_TIMEOUT_SEC)
    response.raise_for_status()
    return response.json() if response.content else {}


def _resolve_history_entry(history_payload: Dict[str, Any], prompt_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(history_payload, dict):
        return None
    direct = history_payload.get(prompt_id)
    if isinstance(direct, dict):
        return direct
    if isinstance(history_payload.get("outputs"), dict):
        return history_payload
    if len(history_payload) == 1:
        only_value = next(iter(history_payload.values()))
        if isinstance(only_value, dict) and isinstance(only_value.get("outputs"), dict):
            return only_value
    return None


def _extract_outputs(history_payload: Dict[str, Any], prompt_id: str) -> List[Dict[str, Any]]:
    outputs: List[Dict[str, Any]] = []
    entry = _resolve_history_entry(history_payload, prompt_id) or {}
    node_outputs = entry.get("outputs", {}) if isinstance(entry, dict) else {}
    for node_data in node_outputs.values():
        if not isinstance(node_data, dict):
            continue
        for key, media_type in (("images", "image"), ("videos", "video"), ("gifs", "video"), ("audio", "audio")):
            for item in node_data.get(key, []) or []:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                outputs.append(
                    {
                        "filename": str(item.get("filename")),
                        "subfolder": str(item.get("subfolder") or ""),
                        "type": str(item.get("type") or "output"),
                        "media_type": media_type,
                    }
                )
        for raw_value in node_data.values():
            if isinstance(raw_value, dict) and raw_value.get("filename"):
                filename = str(raw_value.get("filename") or "")
                media_type = _classify_preview_media_type(Path(filename))
                outputs.append(
                    {
                        "filename": filename,
                        "subfolder": str(raw_value.get("subfolder") or ""),
                        "type": str(raw_value.get("type") or "output"),
                        "media_type": media_type,
                    }
                )
            elif isinstance(raw_value, list):
                for item in raw_value:
                    if not isinstance(item, dict) or not item.get("filename"):
                        continue
                    filename = str(item.get("filename") or "")
                    media_type = _classify_preview_media_type(Path(filename))
                    outputs.append(
                        {
                            "filename": filename,
                            "subfolder": str(item.get("subfolder") or ""),
                            "type": str(item.get("type") or "output"),
                            "media_type": media_type,
                        }
                    )
    deduped: List[Dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in outputs:
        key = (
            str(item.get("filename") or ""),
            str(item.get("subfolder") or ""),
            str(item.get("type") or ""),
            str(item.get("media_type") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _classify_preview_media_type(path: Path) -> str:
    suffix = str(path.suffix or "").lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
        return "image"
    if suffix in {".mp4", ".mov", ".webm", ".mkv", ".avi"}:
        return "video"
    if suffix in {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}:
        return "audio"
    return "file"


def _collect_preview_save_prefixes(workflow: Dict[str, Any]) -> List[str]:
    prefixes: List[str] = []
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        if class_type not in {"SaveVideo", "VHS_VideoCombine", "SaveAnimatedWEBP"}:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        filename_prefix = str(inputs.get("filename_prefix") or "").strip().strip("/\\")
        if filename_prefix:
            prefixes.append(Path(filename_prefix).name)
    return prefixes


def _set_preview_save_prefix_suffix(workflow: Dict[str, Any], suffix: str) -> None:
    safe_suffix = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(suffix or "").strip()).strip("_")
    if not safe_suffix:
        return
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        if class_type not in {"SaveVideo", "VHS_VideoCombine", "SaveAnimatedWEBP"}:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        filename_prefix = str(inputs.get("filename_prefix") or "").strip().strip("/\\")
        if not filename_prefix:
            continue
        prefix_path = Path(filename_prefix)
        parent = str(prefix_path.parent).strip(".")
        stem = prefix_path.name
        updated_name = f"{stem}_{safe_suffix}"
        inputs["filename_prefix"] = f"{parent}/{updated_name}".strip("/") if parent else updated_name


def _find_recent_preview_outputs(
    *,
    media_type: str,
    started_at: float,
    prefixes: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    wanted = str(media_type or "").strip().lower()
    prefix_values = [str(item or "").strip().lower() for item in (prefixes or []) if str(item or "").strip()]
    matches: List[Dict[str, Any]] = []
    search_roots = [OUTPUT_DIR, COMFY_OUTPUT_DIR]
    for root in search_roots:
        if not root.exists():
            continue
        try:
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                classified = _classify_preview_media_type(path)
                if classified != wanted:
                    continue
                try:
                    mtime = float(path.stat().st_mtime)
                except Exception:
                    continue
                if mtime < float(started_at):
                    continue
                stem = str(path.stem or "").lower()
                filename = str(path.name or "").lower()
                if prefix_values and not any(stem.startswith(prefix) or filename.startswith(prefix) for prefix in prefix_values):
                    continue
                try:
                    relative_parent = path.parent.relative_to(root)
                    subfolder = "" if str(relative_parent) == "." else str(relative_parent).replace("\\", "/")
                except Exception:
                    subfolder = ""
                matches.append(
                    {
                        "filename": path.name,
                        "subfolder": subfolder,
                        "type": "output",
                        "media_type": classified,
                        "mtime": mtime,
                    }
                )
        except Exception:
            continue
    matches.sort(key=lambda item: float(item.get("mtime") or 0.0), reverse=True)
    return matches


def _find_recent_ready_preview_output(
    *,
    media_type: str,
    started_at: float,
    prefixes: Optional[List[str]] = None,
    require_prefix: bool = False,
) -> Optional[Dict[str, Any]]:
    matches = _find_recent_preview_outputs(
        media_type=media_type,
        started_at=started_at,
        prefixes=prefixes,
    )
    if require_prefix and not matches:
        return None
    if not matches and not require_prefix:
        matches = _find_recent_preview_outputs(
            media_type=media_type,
            started_at=started_at,
            prefixes=None,
        )

    for item in matches:
        filename = str(item.get("filename") or "").strip()
        if not filename:
            continue
        try:
            path = _resolve_preview_media_source(filename, None)
        except Exception:
            continue
        if not path.exists() or not path.is_file():
            continue
        try:
            if media_type == "video" and _probe_preview_media_duration(path) <= 0.05:
                continue
        except Exception:
            continue
        return item
    return None


def _resolve_preview_media_source(filename: str, client_session_id: Optional[str]) -> Path:
    safe_name = _safe_name(filename)
    common_output_subfolders = ["image", "images", "audio", "video", "videos"]
    candidates = [
        _preview_audio_dir(client_session_id) / safe_name,
        _preview_ref_images_dir(client_session_id) / safe_name,
        REF_IMAGES_DIR / safe_name,
        INPUT_DIR / safe_name,
        OUTPUT_DIR / safe_name,
        COMFY_INPUT_DIR / safe_name,
        COMFY_OUTPUT_DIR / safe_name,
    ]
    for subfolder in common_output_subfolders:
        candidates.append(OUTPUT_DIR / subfolder / safe_name)
        candidates.append(COMFY_OUTPUT_DIR / subfolder / safe_name)
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate
    for base_dir in [OUTPUT_DIR, COMFY_OUTPUT_DIR]:
        try:
            for matched in base_dir.rglob(safe_name):
                if matched.exists() and matched.is_file():
                    return matched
        except Exception:
            continue
    raise HTTPException(status_code=404, detail=f"Media not found: {filename}")


def _sync_input_image_to_comfy_input(filename: str, client_session_id: Optional[str]) -> str:
    source = _resolve_preview_media_source(filename, client_session_id)
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_name(source.name)
    destination = COMFY_INPUT_DIR / safe_name
    if source.resolve() != destination.resolve():
        shutil.copy2(source, destination)
    return safe_name


def _fit_preview_image_to_canvas(
    source: Path,
    *,
    client_session_id: Optional[str],
    target_width: int = 1280,
    target_height: int = 720,
    mode: str = "contain_blur",
    anchor_y: float = 0.5,
) -> Path:
    if Image is None or ImageFilter is None or ImageOps is None:
        raise HTTPException(status_code=500, detail="Pillow is required for image fitting. Run: pip install -r requirements.txt")

    width = max(64, min(int(target_width or 1280), 4096))
    height = max(64, min(int(target_height or 720), 4096))
    fit_mode = str(mode or "contain_blur").strip().lower()
    safe_anchor_y = max(0.0, min(float(anchor_y if anchor_y is not None else 0.5), 1.0))

    with Image.open(source) as opened:
        src = ImageOps.exif_transpose(opened).convert("RGBA")
        if src.width <= 0 or src.height <= 0:
            raise HTTPException(status_code=400, detail="Invalid image size")

        if fit_mode == "cover_crop":
            scale = max(width / src.width, height / src.height)
            resized = src.resize((max(1, round(src.width * scale)), max(1, round(src.height * scale))), Image.Resampling.LANCZOS)
            left = max(0, (resized.width - width) // 2)
            if resized.height > height:
                top = max(0, min(resized.height - height, round((resized.height - height) * safe_anchor_y)))
            else:
                top = 0
            canvas = resized.crop((left, top, left + width, top + height))
        else:
            scale = min(width / src.width, height / src.height)
            resized = src.resize((max(1, round(src.width * scale)), max(1, round(src.height * scale))), Image.Resampling.LANCZOS)

            if fit_mode == "contain":
                canvas = Image.new("RGBA", (width, height), (0, 0, 0, 255))
            else:
                bg_scale = max(width / src.width, height / src.height)
                background = src.resize((max(1, round(src.width * bg_scale)), max(1, round(src.height * bg_scale))), Image.Resampling.LANCZOS)
                bg_left = max(0, (background.width - width) // 2)
                bg_top = max(0, (background.height - height) // 2)
                canvas = background.crop((bg_left, bg_top, bg_left + width, bg_top + height))
                canvas = canvas.filter(ImageFilter.GaussianBlur(radius=max(12, round(min(width, height) * 0.035))))
                dim = Image.new("RGBA", (width, height), (0, 0, 0, 72))
                canvas = Image.alpha_composite(canvas, dim)

            paste_x = (width - resized.width) // 2
            paste_y = (height - resized.height) // 2
            canvas.alpha_composite(resized, (paste_x, paste_y))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^a-zA-Z0-9._-]", "_", source.stem)[:80] or "image"
    output_name = f"{stem}_fit_{width}x{height}_{uuid.uuid4().hex[:8]}.png"
    output_path = OUTPUT_DIR / output_name
    canvas.convert("RGB").save(output_path, format="PNG", optimize=True)
    return output_path


PRESET_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "character_story_mv",
        "name": "キャラ主導MV",
        "tagline": "キャラクタ設計から世界観・音楽・映像まで一気通貫で制作",
        "description": "オリジナルキャラクタを軸に、歌詞や世界観を育てながらMVを構築する標準プリセットです。",
        "recommended_mode": "new",
        "default_pipeline_preset_id": "char_edit_i2i_flf",
        "pipeline_options": [
            {
                "id": "char_edit_i2i_flf",
                "label": "キャラ一貫性を重視した標準動画制作",
                "description": "キャラの統一感と長尺運用を両立しやすい標準的な制作構成です。",
            },
            {
                "id": "char_edit_i2v_mixed",
                "label": "品質と柔軟性を両立させた高度な動画制作",
                "description": "シーン長可変と混在トランジション自動化により、複雑な構成の制作へ柔軟に対応します。",
            },
            {
                "id": "char_edit_i2v_scene_cut",
                "label": "シーン単位で調整しやすい動画制作",
                "description": "シーンごとの差し替えや再調整を行いやすい制作構成です。",
            },
            {
                "id": "char_i2i_flf",
                "label": "高速な連続長尺動画制作",
                "description": "FLF中心でテンポよく長尺動画を制作したい場合に向きます。",
            },
        ],
        "flow_summary": [
            "キャラ設定を起点に世界観と歌詞を連動",
            "音楽制作の後にシーン画像と動画を段階生成",
            "最後にMVとして統合して完成形を確認",
        ],
        "steps": [
            {
                "id": "character",
                "title": "キャラクタ作成",
                "short": "見た目・性格・参照画像を定義",
                "objective": "主人公の造形と参照素材を固め、後続STEPでブレない基準を作ります。",
                "summary_points": ["容姿・衣装・色設計", "立ち絵や参考画像の登録", "固定タグと禁止要素の整理"],
                "subflows": ["キャラシート生成", "参照画像登録", "表情差分の候補作成"],
                "settings": ["キャラクタ名", "年齢感・性格", "衣装テーマ", "参照画像ソース"],
                "outputs": ["キャラ定義", "参照画像セット", "共通プロンプト断片"],
                "handoff": "ここで確定した参照情報がシナリオ・シーン画像生成へ受け渡されます。",
            },
            {
                "id": "story",
                "title": "シナリオ・世界観作成",
                "short": "歌詞・舞台設定・シーン構成を設計",
                "objective": "MV全体のストーリーと見せ場を文章で整理し、各シーンに落とし込める状態にします。",
                "summary_points": ["物語の起承転結", "ロケーションと時間帯", "シーンごとの感情変化"],
                "subflows": ["世界観メモ生成", "歌詞・ナレーション案", "シーン分割"],
                "settings": ["ジャンル", "尺", "シーン数", "歌詞の有無"],
                "outputs": ["シナリオ全文", "音楽作成への受け渡しメモ", "演出メモ"],
                "handoff": "ここではシーン画像用プロンプトは作らず、先に音楽作成で歌詞と尺を固めた後にシーン画像作成へ渡します。",
            },
            {
                "id": "music",
                "title": "音楽作成",
                "short": "歌・BGM・テンポ感を決定",
                "objective": "映像尺に合う音楽素材を用意し、映像編集時の基準となる拍と盛り上がりを定めます。",
                "summary_points": ["BPMやキーの決定", "歌詞との同期確認", "完成尺の固定"],
                "subflows": ["楽曲生成", "歌詞修正", "尺調整と書き出し"],
                "settings": ["BPM", "キー", "歌唱言語", "尺"],
                "outputs": ["仮ミックス音源", "確定歌詞", "時間配分メモ", "シーン画像向け音楽メモ"],
                "handoff": "確定した歌詞・BPM・盛り上がり位置をシーン画像作成へ渡し、その後シーン動画作成の長さ配分へ反映します。",
            },
            {
                "id": "scene_image",
                "title": "シーン画像作成",
                "short": "各カットのキービジュアルを生成",
                "objective": "シナリオの各場面を静止画で可視化し、映像化前に画づくりをレビューします。",
                "summary_points": ["シーンごとの構図設計", "キャラ整合性確認", "色味・ライティングの統一", "音楽作成で確定した尺と歌詞を参照"],
                "subflows": ["ラフ生成", "i2iブラッシュアップ", "採用カット整理"],
                "settings": ["構図", "カメラ距離", "背景", "画角比率"],
                "outputs": ["シーン別静止画", "差し替え候補", "修正メモ", "尺参照メモ"],
                "handoff": "実装時は音楽作成で確定した長さと歌詞を参照してシーン画像プロンプトを組み立て、その後採用画像を動画生成の開始フレームとして使います。",
            },
            {
                "id": "scene_video",
                "title": "シーン動画作成",
                "short": "静止画を動かし演出を追加",
                "objective": "各シーンにモーションやカメラワークを与え、完成MVのクリップ群を作ります。",
                "summary_points": ["カメラ移動", "ループ・尺合わせ", "演出強度の調整"],
                "subflows": ["i2v生成", "FLF補間", "尺調整"],
                "settings": ["FPS", "秒数", "動きの強さ", "カメラ演出"],
                "outputs": ["シーン動画クリップ", "再生成候補", "接続順"],
                "handoff": "完成クリップをMV統合へ渡して最終編集に入ります。",
            },
            {
                "id": "final_mv",
                "title": "完成MV",
                "short": "音と映像を結合して最終出力",
                "objective": "全STEPの成果物を統合し、確認用と納品用のMVを出力します。",
                "summary_points": ["映像と音声の結合", "冒頭・末尾の調整", "完成版の確認"],
                "subflows": ["クリップ結合", "音合わせ", "最終レンダリング"],
                "settings": ["出力解像度", "フォーマット", "音量", "フェード"],
                "outputs": ["完成MV", "確認用プレビュー", "出力ログ"],
                "handoff": "完成後は編集モードで一部STEPへ戻り、差し替え改善できます。",
            },
        ],
    },
    {
        "id": "lyrics_focus_mv",
        "name": "歌詞重視MV",
        "tagline": "歌詞と世界観の同期を重視した構成",
        "description": "先に歌詞・情景・尺を詰めてからキャラクタや映像演出を固めるプリセットです。",
        "recommended_mode": "step",
        "default_pipeline_preset_id": "t2i_i2v_scene_continuous",
        "pipeline_options": [
            {
                "id": "t2i_i2v_scene_continuous",
                "label": "歌詞の流れをつなぎやすい連続動画制作",
                "description": "シーンの連続感を保ちながら歌詞と情景を見せやすい標準的な制作構成です。",
            },
            {
                "id": "ext_i2i_i2v_mixed",
                "label": "印象カットと遷移品質を両立した動画制作",
                "description": "I2Iと混在トランジションで印象シーンを強化したい制作に向きます。",
            },
            {
                "id": "t2i_i2v",
                "label": "分かりやすい基本動画制作",
                "description": "構成が素直で扱いやすい、歌詞重視MVの基本的な制作形です。",
            },
            {
                "id": "t2v_i2v_scene_continuous",
                "label": "画像工程を減らした上級者向け動画制作",
                "description": "直接動画制作を増やして、より短い工程で連続動画を制作します。",
            },
        ],
        "flow_summary": [
            "歌詞・世界観を先に確定して迷いを減らす",
            "必要最低限のキャラ設定で映像に集中",
            "完成後もシーン単位で差し替えしやすい構成",
        ],
        "steps": [
            {
                "id": "story",
                "title": "歌詞・構成設計",
                "short": "先に情景と歌詞表現を固める",
                "objective": "歌詞とシーンの対応表を先に作り、映像の意味づけを明確にします。",
                "summary_points": ["歌詞ブロック設計", "サビ見せ場", "情景キーワード"],
                "subflows": ["歌詞案生成", "構成表編集", "キーフレーズ抽出"],
                "settings": ["尺", "シーン数", "曲調", "言語"],
                "outputs": ["歌詞方針メモ", "情景マップ", "演出ノート"],
                "handoff": "ここではシーン画像用プロンプトは作らず、音楽作成で歌詞を確定した後にシーン画像作成へ渡します。",
            },
            {
                "id": "character",
                "title": "キャラ・モチーフ整理",
                "short": "最低限の見た目を設計",
                "objective": "歌詞に合う象徴的モチーフを作り、映像内の反復要素を決めます。",
                "summary_points": ["主人公の印象", "象徴アイテム", "色のモチーフ"],
                "subflows": ["モチーフ選定", "参照画像登録", "キャラシート簡易版"],
                "settings": ["キーカラー", "衣装", "小物", "参照画像"],
                "outputs": ["簡易キャラ設定", "モチーフ一覧", "共通タグ"],
                "handoff": "シーン画像生成時に歌詞とモチーフを掛け合わせます。",
            },
            {
                "id": "scene_image",
                "title": "歌詞と表現のシーン画像",
                "short": "歌詞ごとの印象を静止画化",
                "objective": "キーフレーズごとに象徴カットを作り、サビや印象シーンを強化します。",
                "summary_points": ["印象カット優先", "色の反復", "歌詞の視覚化", "音楽作成で確定した尺を参照"],
                "subflows": ["歌詞別ラフ生成", "選抜", "追い込み"],
                "settings": ["フレーズ", "構図", "色調", "強調したい小物"],
                "outputs": ["歌詞対応画像", "印象カット", "再生成候補", "尺参照メモ"],
                "handoff": "実装時は音楽作成で確定した長さ・歌詞・盛り上がり位置を参照してシーン画像プロンプトを組み立て、重要カットを中心に動画STEPへ送ります。",
            },
            {
                "id": "scene_video",
                "title": "歌詞同期動画",
                "short": "ビートと画変化を合わせる",
                "objective": "拍や歌い出しに合わせて動きの強弱を設定し、視聴体験を最適化します。",
                "summary_points": ["サビの動きを強める", "Aメロは抑えめ", "歌詞切替と画変化"],
                "subflows": ["動画生成", "尺再配置", "歌詞同期確認"],
                "settings": ["秒数", "トランジション", "カメラ演出", "強調区間"],
                "outputs": ["同期済みクリップ", "尺メモ", "確認版"],
                "handoff": "最終MV組み立てに使うメイン素材が揃います。",
            },
            {
                "id": "final_mv",
                "title": "MV統合",
                "short": "歌詞重視の最終仕上げ",
                "objective": "歌詞の見せ場を損なわないよう全体を整え、完成版へ仕上げます。",
                "summary_points": ["サビピーク確認", "不要カット整理", "完成版の書き出し"],
                "subflows": ["全体確認", "つなぎ微調整", "書き出し"],
                "settings": ["最終尺", "音量", "出力形式", "テロップ有無"],
                "outputs": ["完成MV", "サムネ候補", "修正版TODO"],
                "handoff": "編集モードから任意STEPに戻って再調整できます。",
            },
        ],
    },
    {
        "id": "edit_rebuild_mv",
        "name": "既存素材編集MV",
        "tagline": "既存キャンバスや完成物の部分差し替え向け",
        "description": "すでにあるキャラ・音源・シーンを流用しながら、必要STEPだけ再編集するためのプリセットです。",
        "recommended_mode": "edit",
        "default_pipeline_preset_id": "ext_i2i_i2v_scene_cut",
        "pipeline_options": [
            {
                "id": "ext_i2i_i2v_scene_cut",
                "label": "差し替え範囲を絞りやすい動画制作",
                "description": "局所的な再制作や差し替えに向いた、最初の選択肢です。",
            },
            {
                "id": "char_edit_i2v_scene_cut",
                "label": "キャラ素材の部分修正に向いた動画制作",
                "description": "キャラ合成済み素材を生かしつつ、シーン単位で再調整できる制作構成です。",
            },
            {
                "id": "ext_i2v",
                "label": "動画だけ軽く差し替える動画制作",
                "description": "既存画像を使って動画区間だけ調整したい制作に向いた軽量構成です。",
            },
            {
                "id": "char_edit_i2v_mixed",
                "label": "品質と柔軟性を両立させた高度な動画制作",
                "description": "差し替え後の遷移品質だけでなく、複雑な構成の制作まで扱えます。",
            },
        ],
        "flow_summary": [
            "既存成果物を読み込み、差し替え対象STEPを選択",
            "影響範囲を確認しながら局所的に再生成",
            "完成MVへ戻して即プレビューできる運用向け",
        ],
        "steps": [
            {
                "id": "load_assets",
                "title": "既存素材読込",
                "short": "過去キャンバスや完成MVを選択",
                "objective": "再編集の起点となる素材を読み込み、どこまで引き継ぐかを決めます。",
                "summary_points": ["既存キャンバス選択", "素材整合性確認", "差し替え候補抽出"],
                "subflows": ["キャンバス読込", "素材マッピング", "差し替え範囲指定"],
                "settings": ["読込元", "保持する成果物", "差し替え対象"],
                "outputs": ["再編集キャンバス", "差し替えリスト", "影響範囲"],
                "handoff": "選んだ差し替え範囲に応じて個別STEPの編集画面へ分岐します。",
            },
            {
                "id": "scene_image",
                "title": "画像差し替え",
                "short": "問題カットだけ修正",
                "objective": "必要なカットだけを再生成し、既存動画への影響を最小化します。",
                "summary_points": ["NGカットの修正", "既存スタイル保持", "差分管理"],
                "subflows": ["対象カット選択", "再生成", "比較レビュー"],
                "settings": ["対象シーン", "保持要素", "変更点", "比較方法"],
                "outputs": ["差し替え画像", "比較結果", "再生成ログ"],
                "handoff": "変更が必要な場合だけ動画STEPも再実行します。",
            },
            {
                "id": "scene_video",
                "title": "動画差し替え",
                "short": "一部クリップのみ再構築",
                "objective": "差し替え対象クリップを再出力し、既存MVへ即時反映できる状態にします。",
                "summary_points": ["一部クリップ再生成", "尺合わせ", "既存MVへの再接続"],
                "subflows": ["差分動画生成", "尺調整", "接続テスト"],
                "settings": ["対象区間", "秒数", "接続方法", "演出強度"],
                "outputs": ["差し替え動画", "接続候補", "プレビューログ"],
                "handoff": "統合STEPで旧クリップと置き換えます。",
            },
            {
                "id": "final_mv",
                "title": "完成MV更新",
                "short": "差分を反映して再出力",
                "objective": "変更箇所のみ反映した新版MVを短時間で確認できるようにします。",
                "summary_points": ["差分だけ更新", "旧版との比較", "版管理"],
                "subflows": ["差分統合", "比較再生", "新版書き出し"],
                "settings": ["バージョン名", "差分ログ", "比較方法", "出力形式"],
                "outputs": ["新版MV", "比較メモ", "更新履歴"],
                "handoff": "必要なら再度任意STEPへ戻って修正を続けます。",
            },
        ],
    },
]


app = FastAPI(title="MV Studio Production", version="1.0.0")


@app.middleware("http")
async def disable_browser_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "music_video_studio.html")


@app.get("/music_video_studio.html")
def production_html():
    return FileResponse(STATIC_DIR / "music_video_studio.html")


@app.get("/api/v1/production/config")
def production_config():
    return {
        "success": True,
        "app": {
            "title": "Music Video Studio",
            "subtitle": "プリセット起点で制作キャンバスとSTEP制作・編集エリアを行き来するMV制作UI",
            "version": "1.0.0",
        },
        "presets": PRESET_CATALOG,
        "modes": [
            {
                "id": "new",
                "label": "自動制作",
                "description": "おまかせで全工程自動",
            },
            {
                "id": "step",
                "label": "STEP作成",
                "description": "特定STEPから始めて必要な工程だけ進める",
            },
            {
                "id": "edit",
                "label": "編集",
                "description": "既存素材の一部を差し替える",
            },
        ],
    }


@app.get("/api/v1/production/state")
def get_production_state(client_session_id: Optional[str] = None):
    sf = _state_file(client_session_id)
    if not sf.exists():
        return {"success": True, "state": None}
    try:
        payload = json.loads(sf.read_text(encoding="utf-8"))
    except Exception:
        payload = {}
    return {
        "success": True,
        "state": payload.get("state") if isinstance(payload, dict) else None,
        "updated_at": payload.get("updated_at") if isinstance(payload, dict) else None,
    }


@app.post("/api/v1/production/state")
def save_production_state(req: ProductionStateRequest):
    sf = _state_file(req.client_session_id)
    sf.parent.mkdir(parents=True, exist_ok=True)
    updated_at = int(time.time())
    wrapped = {
        "updated_at": updated_at,
        "state": req.state if isinstance(req.state, dict) else {},
    }
    sf.write_text(json.dumps(wrapped, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"success": True, "updated_at": updated_at}


@app.post("/api/v1/production/cancel")
def cancel_production_task(req: ProductionCancelRequest):
    target = str(req.target or "").strip().lower()
    if target not in {"scene-image", "scene-video"}:
        raise HTTPException(status_code=400, detail="target must be scene-image or scene-video")
    _set_preview_cancel(req.client_session_id, target, True)
    interrupted = _interrupt_comfyui()
    return {
        "success": True,
        "target": target,
        "client_session_id": _safe_session_id(req.client_session_id),
        "interrupt_sent": interrupted,
    }


@app.get("/api/v1/production/preset/{preset_id}")
def get_production_preset(preset_id: str):
    for preset in PRESET_CATALOG:
        if str(preset.get("id")) == str(preset_id):
            return {"success": True, "preset": preset}
    raise HTTPException(status_code=404, detail=f"Unknown preset: {preset_id}")


@app.get("/api/v1/production/ref-images")
def list_production_ref_images(client_session_id: Optional[str] = None):
    merged: Dict[str, Dict[str, Any]] = {}
    if REF_IMAGES_INDEX.exists():
        try:
            loaded = json.loads(REF_IMAGES_INDEX.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                merged.update(loaded)
        except Exception:
            pass
    merged.update(_read_preview_ref_index(client_session_id))

    items = []
    for name, data in merged.items():
        if not isinstance(data, dict):
            continue
        items.append(
            {
                "name": name,
                "token": f"@{name}",
                "filename": data.get("filename"),
                "original_filename": data.get("original_filename") or data.get("filename"),
                "created_at": data.get("created_at"),
                "preview_url": f"/api/v1/production/ref-images/file/{name}?client_session_id={_safe_session_id(client_session_id)}",
            }
        )
    items.sort(key=lambda item: str(item.get("name") or "").lower())
    return {"success": True, "items": items}


@app.post("/api/v1/production/ref-images")
async def register_production_ref_image(
    name: str = Form(...),
    client_session_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
):
    normalized_name = str(name or "").strip().lstrip("@")
    if not normalized_name:
        raise HTTPException(status_code=400, detail="name is required")

    safe_source = _safe_name(file.filename or "ref_image.png")
    stored_name = f"{Path(safe_source).stem}_{uuid.uuid4().hex[:8]}{Path(safe_source).suffix or '.png'}"
    ref_dir = _preview_ref_images_dir(client_session_id)
    output_path = ref_dir / stored_name
    output_path.write_bytes(await file.read())

    idx = _read_preview_ref_index(client_session_id)
    idx[normalized_name] = {
        "filename": stored_name,
        "original_filename": file.filename or stored_name,
        "created_at": time.time(),
    }
    _write_preview_ref_index(idx, client_session_id)

    return {
        "success": True,
        "name": normalized_name,
        "token": f"@{normalized_name}",
        "filename": stored_name,
        "preview_url": f"/api/v1/production/media/{stored_name}?client_session_id={_safe_session_id(client_session_id)}",
    }


@app.delete("/api/v1/production/ref-images/{name}")
def delete_production_ref_image(name: str, client_session_id: Optional[str] = None):
    normalized_name = str(name or "").strip().lstrip("@")
    if not normalized_name:
        raise HTTPException(status_code=400, detail="name is required")

    idx = _read_preview_ref_index(client_session_id)
    data = idx.pop(normalized_name, None)
    deleted_file = False

    if data and isinstance(data, dict):
        filename = _safe_name(str(data.get("filename") or ""))
        if filename:
            file_path = _preview_ref_images_dir(client_session_id) / filename
            try:
                if file_path.exists() and file_path.is_file():
                    file_path.unlink()
                    deleted_file = True
            except Exception:
                deleted_file = False
        _write_preview_ref_index(idx, client_session_id)
        return {
            "success": True,
            "name": normalized_name,
            "deleted_file": deleted_file,
        }

    # Backward-compatible global registry cleanup for older shared registrations.
    if REF_IMAGES_INDEX.exists():
        try:
            loaded = json.loads(REF_IMAGES_INDEX.read_text(encoding="utf-8"))
        except Exception:
            loaded = {}
        if isinstance(loaded, dict) and normalized_name in loaded:
            data = loaded.pop(normalized_name, None)
            if isinstance(data, dict):
                filename = _safe_name(str(data.get("filename") or ""))
                if filename:
                    file_path = REF_IMAGES_DIR / filename
                    try:
                        if file_path.exists() and file_path.is_file():
                            file_path.unlink()
                            deleted_file = True
                    except Exception:
                        deleted_file = False
            REF_IMAGES_INDEX.write_text(json.dumps(loaded, ensure_ascii=False, indent=2), encoding="utf-8")
            return {
                "success": True,
                "name": normalized_name,
                "deleted_file": deleted_file,
            }

    raise HTTPException(status_code=404, detail=f"Character not found: {normalized_name}")


@app.post("/api/v1/production/upload-ref-slot")
async def upload_production_ref_slot(
    client_session_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
):
    safe_source = _safe_name(file.filename or "ref_slot.png")
    stored_name = f"{Path(safe_source).stem}_{uuid.uuid4().hex[:8]}{Path(safe_source).suffix or '.png'}"
    ref_dir = _preview_ref_images_dir(client_session_id)
    output_path = ref_dir / stored_name
    output_path.write_bytes(await file.read())
    return {
        "success": True,
        "filename": stored_name,
        "original_filename": file.filename or stored_name,
        "preview_url": f"/api/v1/production/media/{stored_name}?client_session_id={_safe_session_id(client_session_id)}",
    }


@app.post("/api/v1/production/music/import", response_model=PreviewMusicGenerateResponse)
async def import_production_music(
    client_session_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
):
    original_filename = str(file.filename or "imported_audio").strip() or "imported_audio"
    safe_source = _safe_name(original_filename)
    suffix = Path(safe_source).suffix.lower()
    allowed_suffixes = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"}
    content_type = str(file.content_type or "").lower()
    if not (content_type.startswith("audio/") or suffix in allowed_suffixes):
        raise HTTPException(status_code=400, detail="audio file is required")

    if suffix not in allowed_suffixes:
        suffix = ".mp3"
    stored_name = f"{Path(safe_source).stem}_{uuid.uuid4().hex[:8]}{suffix}"
    audio_dir = _preview_audio_dir(client_session_id)
    output_path = audio_dir / stored_name
    output_path.write_bytes(await file.read())

    try:
        duration_sec = round(_probe_preview_media_duration(output_path), 2)
    except Exception as exc:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=f"Could not read audio duration: {exc}") from exc

    return PreviewMusicGenerateResponse(
        success=True,
        filename=stored_name,
        subfolder="",
        type="output",
        media_type="audio",
        preview_url=f"/api/v1/production/media/{stored_name}?client_session_id={_safe_session_id(client_session_id)}",
        backend="external-audio",
        source="imported",
        original_filename=original_filename,
        duration_sec=duration_sec,
        elapsed_time=0.0,
    )


@app.post("/api/v1/production/music/trim", response_model=PreviewMusicGenerateResponse)
async def trim_production_music(request: PreviewMusicTrimRequest):
    started = time.time()
    filename = str(request.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")

    try:
        source_path = _resolve_preview_media_source(filename, request.client_session_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Audio not found: {exc}") from exc

    try:
        trimmed_path, duration_sec = _trim_preview_audio_segment(
            source_path,
            client_session_id=request.client_session_id,
            trim_start_sec=request.trim_start_sec,
            trim_end_sec=request.trim_end_sec,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not trim audio: {exc}") from exc

    if duration_sec <= 0.05:
        try:
            trimmed_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail="Trimmed audio is empty")

    original_filename = str(request.original_filename or source_path.name).strip() or source_path.name
    original_stem = Path(original_filename).stem or Path(source_path.name).stem or "audio"
    trimmed_original_filename = f"{original_stem}_trimmed.mp3"
    source_label = str(request.source or "generated").strip().lower()
    if source_label not in {"generated", "imported"}:
        source_label = "generated"

    return PreviewMusicGenerateResponse(
        success=True,
        filename=trimmed_path.name,
        subfolder="",
        type="output",
        media_type="audio",
        preview_url=f"/api/v1/production/media/{trimmed_path.name}?client_session_id={_safe_session_id(request.client_session_id)}",
        backend="ffmpeg-trim",
        source=source_label,
        original_filename=trimmed_original_filename,
        duration_sec=duration_sec,
        elapsed_time=round(time.time() - started, 2),
    )


@app.get("/api/v1/production/media/{filename}")
@app.get("/api/v1/startup-prototype/media/{filename}", include_in_schema=False)
def get_production_media(
    filename: str,
    client_session_id: Optional[str] = None,
    subfolder: Optional[str] = None,
    type: Optional[str] = None,
):
    safe_name = _safe_name(filename)
    candidates = [
        _preview_audio_dir(client_session_id) / safe_name,
        _preview_ref_images_dir(client_session_id) / safe_name,
        REF_IMAGES_DIR / safe_name,
        INPUT_DIR / safe_name,
        OUTPUT_DIR / str(subfolder or "") / safe_name,
        OUTPUT_DIR / safe_name,
        COMFY_INPUT_DIR / safe_name,
        COMFY_OUTPUT_DIR / str(subfolder or "") / safe_name,
        COMFY_OUTPUT_DIR / safe_name,
    ]
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return FileResponse(candidate)
    raise HTTPException(status_code=404, detail=f"Media not found: {filename}")


@app.get("/api/v1/production/ref-images/file/{name}")
@app.get("/api/v1/startup-prototype/ref-images/file/{name}", include_in_schema=False)
def get_production_ref_image_file(name: str, client_session_id: Optional[str] = None):
    merged: Dict[str, Dict[str, Any]] = {}
    if REF_IMAGES_INDEX.exists():
        try:
            loaded = json.loads(REF_IMAGES_INDEX.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                merged.update(loaded)
        except Exception:
            pass
    merged.update(_read_preview_ref_index(client_session_id))
    entry = merged.get(name)
    if not isinstance(entry, dict):
        raise HTTPException(status_code=404, detail=f"Unknown ref image: {name}")
    return get_production_media(str(entry.get("filename") or ""), client_session_id)


@app.post("/api/v1/production/translate", response_model=PreviewTranslateResponse)
async def production_translate(request: PreviewTranslateRequest):
    text = str(request.text or "")
    has_japanese = bool(re.search(r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]", text))

    if request.target_language == "auto":
        source_lang = "ja" if has_japanese else "en"
        target_lang = "en" if has_japanese else "ja"
    else:
        source_lang = "ja" if has_japanese else "en"
        target_lang = str(request.target_language or "en").lower()

    if target_lang == "en":
        system_prompt = (
            "You are a translator. Output ONLY the translated text in English. "
            "No explanations, no notes, no preamble, no markdown. Just the translation."
        )
        user_prompt = f"Translate to English (output translation only):\n{text}"
    else:
        system_prompt = (
            "You are a translator. Output ONLY the translated text in Japanese. "
            "No explanations, no notes, no preamble, no markdown. Just the translation."
        )
        user_prompt = f"Translate to Japanese (output translation only):\n{text}"

    try:
        client = _get_openai_client()
        translated_text = (await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.3,
            max_tokens=1500,
            repeat_penalty=1.15,
        )).strip()
        translated_text = re.sub(r"\s*\(Note:[^)]*\)\s*$", "", translated_text, flags=re.IGNORECASE).strip()
        translated_text = re.sub(r"\s*Note:\s*.+$", "", translated_text, flags=re.IGNORECASE | re.MULTILINE).strip()
        if not translated_text:
            translated_text = _fallback_translate_text(text, target_lang)
    except Exception:
        translated_text = _fallback_translate_text(text, target_lang)

    return PreviewTranslateResponse(
        original_text=text,
        translated_text=translated_text,
        source_language=source_lang,
        target_language=target_lang,
    )


@app.post("/api/v1/production/story/generate", response_model=PreviewStoryGenerateResponse)
async def production_story_generate(request: PreviewStoryGenerateRequest):
    started = time.time()
    idea = str(request.idea or "").strip()
    if not idea:
        raise HTTPException(status_code=400, detail="idea is required")

    character_context = str(request.character_context or "").strip()
    world_notes = str(request.world_notes or "").strip()
    genre = str(request.genre or "").strip()
    scene_count = max(1, min(int(request.scene_count or 5), 8))
    target_duration_sec = max(10, min(int(request.target_duration_sec or 30), 600))
    lyrics_enabled = bool(request.lyrics_enabled)
    language = str(request.language or "ja").strip() or "ja"

    system_prompt = (
        "You are a scenario editor for music videos. "
        "Expand rough ideas into a practical scenario that can be used for downstream music generation and later scene image generation. "
        "Keep the output concise, structured, and reusable. Output plain text only."
    )
    user_prompt = (
        f"OUTPUT_LANGUAGE: {language}\n"
        f"GENRE: {genre or 'MV'}\n"
        f"TARGET_DURATION_SEC: {target_duration_sec}\n"
        f"SCENE_COUNT: {scene_count}\n"
        f"LYRICS_LINKAGE: {'yes' if lyrics_enabled else 'no'}\n\n"
        f"IDEA:\n{idea}\n\n"
        f"CHARACTER_CONTEXT:\n{character_context or '(none)'}\n\n"
        f"WORLD_NOTES:\n{world_notes or '(none)'}\n\n"
        "Write in this structure:\n"
        "1) overall concept\n"
        "2) narrative arc and emotional flow\n"
        "3) handoff notes for music generation\n"
        "4) direction notes for later scene image prompt generation\n"
        "Do NOT write scene-by-scene image prompts. "
        "Do NOT produce a per-scene prompt list in this step. "
        "Lyrics will be finalized in the music step, and scene prompts will be created later in the scene image step. "
        "Keep names, outfit, mood, and setting continuity consistent."
    )

    try:
        client = _get_openai_client()
        scenario_text = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.5,
            max_tokens=2200,
            repeat_penalty=1.1,
        )) or "").strip()
        if not scenario_text:
            scenario_text = _fallback_story_generate(
                idea,
                character_context=character_context,
                world_notes=world_notes,
                genre=genre,
                scene_count=scene_count,
                target_duration_sec=target_duration_sec,
                lyrics_enabled=lyrics_enabled,
                language=language,
            )
    except Exception:
        scenario_text = _fallback_story_generate(
            idea,
            character_context=character_context,
            world_notes=world_notes,
            genre=genre,
            scene_count=scene_count,
            target_duration_sec=target_duration_sec,
            lyrics_enabled=lyrics_enabled,
            language=language,
        )

    merged_notes = world_notes
    if character_context:
        merged_notes = f"{world_notes}\n\n[character_context]\n{character_context}".strip()

    return PreviewStoryGenerateResponse(
        success=True,
        scenario_text=scenario_text,
        scene_outline=[],
        world_notes=merged_notes,
        elapsed_time=round(time.time() - started, 2),
    )


@app.post("/api/v1/production/music/plan", response_model=PreviewMusicPlanGenerateResponse)
async def production_music_plan_generate(request: PreviewMusicPlanGenerateRequest):
    started = time.time()
    scenario_text = str(request.scenario_text or "").strip()
    world_notes = str(request.world_notes or "").strip()
    character_context = str(request.character_context or "").strip()
    music_prompt = str(request.music_prompt or "").strip()
    genre = str(request.genre or "").strip()
    target_duration_sec = max(10, min(int(request.target_duration_sec or 30), 600))
    vocal_language = str(request.vocal_language or "ja").strip() or "ja"
    bpm = None if request.bpm in (None, 0, "") else max(60, min(int(request.bpm), 220))
    key_signature = _normalize_music_key_signature(request.key_signature)
    has_vocals = bool(request.has_vocals)
    instrumental_focus = bool(request.instrumental_focus)

    if not any([scenario_text, world_notes, music_prompt, character_context]):
        raise HTTPException(status_code=400, detail="music context is required")

    system_prompt = (
        "You are a music planning assistant for music video production. "
        "Create a concise production-ready music plan that helps the user finalize lyrics, tags, BPM, key, and arrangement notes before scene image prompt generation. "
        "Output plain text only."
    )
    user_prompt = (
        f"VOCAL_LANGUAGE: {vocal_language}\n"
        f"TARGET_DURATION_SEC: {target_duration_sec}\n"
        f"HAS_VOCALS: {'yes' if has_vocals else 'no'}\n"
        f"INSTRUMENTAL_FOCUS: {'yes' if instrumental_focus else 'no'}\n"
        f"GENRE_HINT: {genre or '(none)'}\n"
        f"BPM_HINT: {bpm if bpm else '(auto)'}\n"
        f"KEY_HINT: {key_signature or '(auto)'}\n\n"
        f"SCENARIO_TEXT:\n{scenario_text or '(none)'}\n\n"
        f"WORLD_NOTES:\n{world_notes or '(none)'}\n\n"
        f"CHARACTER_CONTEXT:\n{character_context or '(none)'}\n\n"
        f"MUSIC_DIRECTION:\n{music_prompt or '(none)'}\n\n"
        "Return in this structure:\n"
        "TITLE: ...\n"
        "BPM: ...\n"
        "KEY: ...\n"
        "TAGS: ...\n"
        "ARRANGEMENT_NOTES:\n...\n"
        "LYRICS:\n...\n"
        "The lyrics should be concise and production-ready if vocals are enabled."
    )

    try:
        client = _get_openai_client()
        raw_text = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.55,
            max_tokens=2200,
            repeat_penalty=1.1,
        )) or "").strip()
        if not raw_text:
            raise RuntimeError("empty music plan")

        title_match = re.search(r"^TITLE:\s*(.+)$", raw_text, flags=re.MULTILINE)
        bpm_match = re.search(r"^BPM:\s*(.+)$", raw_text, flags=re.MULTILINE)
        key_match = re.search(r"^KEY:\s*(.+)$", raw_text, flags=re.MULTILINE)
        tags_match = re.search(r"^TAGS:\s*(.+)$", raw_text, flags=re.MULTILINE)
        arrangement_match = re.search(r"ARRANGEMENT_NOTES:\s*(.*?)(?:\nLYRICS:|$)", raw_text, flags=re.DOTALL)
        lyrics_match = re.search(r"LYRICS:\s*(.*)$", raw_text, flags=re.DOTALL)

        title = str(title_match.group(1) if title_match else "").strip()
        bpm_value = None
        if bpm_match:
            bpm_digits = re.search(r"\d{2,3}", bpm_match.group(1))
            bpm_value = int(bpm_digits.group(0)) if bpm_digits else bpm
        key_value = _normalize_music_key_signature(key_match.group(1) if key_match else key_signature)
        tags_text = str(tags_match.group(1) if tags_match else "").strip()
        arrangement_notes = str(arrangement_match.group(1) if arrangement_match else "").strip()
        lyrics_text = str(lyrics_match.group(1) if lyrics_match else "").strip()

        if not any([title, tags_text, arrangement_notes, lyrics_text]):
            raise RuntimeError("music plan parse failed")

        response_payload = {
            "title": title,
            "lyrics_text": lyrics_text,
            "music_tags": tags_text,
            "arrangement_notes": arrangement_notes,
            "recommended_bpm": bpm_value if bpm_value else bpm,
            "key_signature": key_value,
        }
    except Exception:
        response_payload = _fallback_music_plan_generate(
            scenario_text=scenario_text,
            world_notes=world_notes,
            character_context=character_context,
            music_prompt=music_prompt,
            genre=genre,
            target_duration_sec=target_duration_sec,
            vocal_language=vocal_language,
            bpm=bpm,
            key_signature=key_signature,
            has_vocals=has_vocals,
            instrumental_focus=instrumental_focus,
        )

    return PreviewMusicPlanGenerateResponse(
        success=True,
        title=str(response_payload.get("title") or "").strip(),
        lyrics_text=str(response_payload.get("lyrics_text") or "").strip(),
        music_tags=str(response_payload.get("music_tags") or "").strip(),
        arrangement_notes=str(response_payload.get("arrangement_notes") or "").strip(),
        recommended_bpm=response_payload.get("recommended_bpm"),
        key_signature=_normalize_music_key_signature(response_payload.get("key_signature")),
        elapsed_time=round(time.time() - started, 2),
    )


@app.post("/api/v1/production/music/generate", response_model=PreviewMusicGenerateResponse)
def production_music_generate(request: PreviewMusicGenerateRequest):
    started = time.time()
    tags = str(request.tags or "").strip()
    lyrics = _sanitize_preview_ace_step_lyrics(str(request.lyrics or "").strip())
    language = str(request.language or "ja").strip() or "ja"
    duration = max(10, min(int(request.duration or 30), 600))
    bpm = None if request.bpm in (None, 0, "") else max(60, min(int(request.bpm), 220))
    timesignature = str(request.timesignature or "4").strip() or "4"
    keyscale = _normalize_music_key_signature(request.keyscale) or None
    steps = max(4, min(int(request.steps or 8), 80))
    cfg = max(0.1, min(float(request.cfg or 3.0), 20.0))
    seed = request.seed if isinstance(request.seed, int) and request.seed > 0 else None

    if not tags:
        raise HTTPException(status_code=400, detail="tags are required")
    if language != "inst" and not lyrics:
        raise HTTPException(status_code=400, detail="lyrics are required unless instrumental mode is selected")

    print(
        "[production] music-generate request",
        {
            "client_session_id": _safe_session_id(request.client_session_id),
            "backend": "ace-step-api" if ACE_STEP_URL else "comfyui",
            "language": language,
            "duration": duration,
            "bpm": bpm,
            "timesignature": timesignature,
            "keyscale": keyscale,
            "steps": steps,
            "cfg": cfg,
            "thinking": request.thinking,
            "tags_preview": tags[:180],
            "lyrics_length": len(lyrics),
        },
    )

    ace_error: Optional[Exception] = None
    try:
        if ACE_STEP_URL:
            try:
                result = _generate_music_audio_via_ace_step_api(
                    tags=tags,
                    lyrics=lyrics,
                    language=("ja" if language == "inst" else language),
                    duration=duration,
                    bpm=bpm,
                    timesignature=timesignature,
                    keyscale=keyscale,
                    steps=steps,
                    cfg=cfg,
                    seed=seed,
                    thinking=bool(request.thinking),
                )
            except Exception as exc:
                ace_error = exc
                print(
                    "[production] music-generate fallback",
                    {
                        "from": "ace-step-api",
                        "to": "comfyui",
                        "reason": str(exc),
                    },
                )
                result = _generate_music_audio_via_comfy(
                    client_session_id=request.client_session_id,
                    tags=tags,
                    lyrics=("[Instrumental]" if language == "inst" and not lyrics else lyrics),
                    language=("ja" if language == "inst" else language),
                    duration=duration,
                    bpm=bpm,
                    timesignature=timesignature,
                    keyscale=keyscale,
                    steps=steps,
                    cfg=cfg,
                    seed=seed,
                )
        else:
            result = _generate_music_audio_via_comfy(
                client_session_id=request.client_session_id,
                tags=tags,
                lyrics=("[Instrumental]" if language == "inst" and not lyrics else lyrics),
                language=("ja" if language == "inst" else language),
                duration=duration,
                bpm=bpm,
                timesignature=timesignature,
                keyscale=keyscale,
                steps=steps,
                cfg=cfg,
                seed=seed,
            )
    except Exception as exc:
        print(
            "[production] music-generate error",
            {
                "backend": "ace-step-api" if ACE_STEP_URL else "comfyui",
                "detail": str(exc),
                "keyscale": keyscale,
            },
        )
        if ace_error is not None:
            detail = f"ACE-Step API failed: {ace_error} / ComfyUI fallback failed: {exc}"
        else:
            detail = str(exc)
        raise HTTPException(status_code=502, detail=detail) from exc

    preview_url = (
        f"/api/v1/production/media/{_safe_name(str(result.get('filename') or ''))}"
        f"?client_session_id={_safe_session_id(request.client_session_id)}"
        f"&subfolder={result.get('subfolder') or ''}"
        f"&type={result.get('type') or 'output'}"
    )
    duration_sec = 0.0
    try:
        output_filename = str(result.get("filename") or "").strip()
        if output_filename:
            output_path = _resolve_preview_media_source(output_filename, request.client_session_id)
            duration_sec = round(_probe_preview_media_duration(output_path), 2)
    except Exception:
        duration_sec = 0.0

    return PreviewMusicGenerateResponse(
        success=True,
        filename=str(result.get("filename") or "").strip(),
        subfolder=str(result.get("subfolder") or "").strip(),
        type=str(result.get("type") or "output").strip(),
        media_type="audio",
        preview_url=preview_url,
        backend=str(result.get("backend") or ("ace-step-api" if ACE_STEP_URL else "comfyui")),
        source="generated",
        original_filename=str(result.get("filename") or "").strip(),
        duration_sec=duration_sec,
        elapsed_time=round(time.time() - started, 2),
    )


@app.post("/api/v1/production/scene-image/prompts", response_model=PreviewScenePromptGenerateResponse)
async def production_scene_prompt_generate(request: PreviewScenePromptGenerateRequest):
    started = time.time()
    scenario_text = str(request.scenario_text or "").strip()
    world_notes = str(request.world_notes or "").strip()
    lyrics_text = str(request.lyrics_text or "").strip()
    arrangement_notes = str(request.arrangement_notes or "").strip()
    music_tags = str(request.music_tags or "").strip()
    character_context = str(request.character_context or "").strip()
    pipeline_preset_id = str(request.pipeline_preset_id or "").strip()
    workflow_mode = str(request.workflow_mode or "").strip()
    scene_count = max(1, min(int(request.scene_count or 5), MAX_PREVIEW_SCENE_COUNT))
    target_duration_sec = max(10, min(int(request.target_duration_sec or 30), 600))
    language = str(request.language or "en").strip() or "en"

    if not any([scenario_text, world_notes, lyrics_text, arrangement_notes, character_context]):
        raise HTTPException(status_code=400, detail="scene prompt context is required")

    durations, scene_count = await _generate_preview_scene_duration_plan_with_count(
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        scene_count=scene_count,
        target_duration_sec=target_duration_sec,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
        propose_scene_count=True,
    )
    lyric_units = _extract_lyric_units(lyrics_text)
    transitions, transition_reasons = await _generate_preview_scene_transition_plan(
        scene_count=scene_count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )

    system_prompt = (
        "You are an expert image prompt engineer for anime-style music video keyframes. "
        "Create exactly N self-contained still-image prompts for scene image generation. "
        "Each prompt must work independently, so restate essential character and setting details every time. "
        "Prefer English prompt wording even if the source notes are Japanese. "
        "Use a single full-frame composition, keep one primary subject unless the source clearly requires a group, "
        "and avoid text, logos, split screens, collage layouts, or duplicated characters. "
        "Output plain text only with #N: lines and no extra commentary."
    )
    duration_lines = "\n".join([f"#{idx + 1}: about {sec}s" for idx, sec in enumerate(durations)])
    lyric_lines = "\n".join([f"#{idx + 1}: {_pick_scene_lyric_excerpt(lyric_units, idx, scene_count) or '(none)'}" for idx in range(scene_count)])
    user_prompt = (
        f"OUTPUT_LANGUAGE: {language}\n"
        f"SCENE_COUNT: {scene_count}\n"
        f"TARGET_DURATION_SEC: {target_duration_sec}\n\n"
        f"SCENARIO_TEXT:\n{scenario_text or '(none)'}\n\n"
        f"WORLD_NOTES:\n{world_notes or '(none)'}\n\n"
        f"CHARACTER_CONTEXT:\n{character_context or '(none)'}\n\n"
        f"MUSIC_TAGS:\n{music_tags or '(none)'}\n\n"
        f"ARRANGEMENT_NOTES:\n{arrangement_notes or '(none)'}\n\n"
        f"LYRIC_EXCERPTS_PER_SCENE:\n{lyric_lines}\n\n"
        f"DURATION_PLAN:\n{duration_lines}\n\n"
        "Write scene prompts for still-image generation only. "
        "Each line must correspond to one scene and must be visually specific: subject, composition, environment, lighting, color, and mood cues. "
        "Do not describe camera motion or video transitions. Output exactly #1: ... #N: ..."
    )

    try:
        client = _get_openai_client()
        raw_text = str((await chat_req(
            client,
            user_prompt,
            system_prompt,
            temperature=0.45,
            max_tokens=2600,
            repeat_penalty=1.1,
        )) or "").strip()
        parsed = _parse_preview_numbered_prompts(raw_text, desired_count=scene_count)
        if not parsed:
            raise RuntimeError("scene prompt parse failed")
        items = [
            {
                "scene_index": idx + 1,
                "prompt": str((parsed[idx] or {}).get("prompt") or "").strip(),
                "duration_sec": durations[idx],
                "lyric_excerpt": _pick_scene_lyric_excerpt(lyric_units, idx, scene_count),
                "transition_type": transitions[idx] if idx < len(transitions) else _normalize_preview_transition_type("none", scene_index=idx + 1),
                "transition_reason": transition_reasons[idx] if idx < len(transition_reasons) else "",
            }
            for idx in range(scene_count)
        ]
        if not any(str(item.get("prompt") or "").strip() for item in items):
            raise RuntimeError("scene prompts are empty")
    except Exception:
        items = _fallback_scene_prompt_generate(
            scenario_text=scenario_text,
            world_notes=world_notes,
            lyrics_text=lyrics_text,
            arrangement_notes=arrangement_notes,
            music_tags=music_tags,
            character_context=character_context,
            scene_count=scene_count,
            target_duration_sec=target_duration_sec,
            pipeline_preset_id=pipeline_preset_id,
            workflow_mode=workflow_mode,
        )

    return PreviewScenePromptGenerateResponse(
        success=True,
        scene_prompts=[PreviewScenePromptItem(**item) for item in items],
        elapsed_time=round(time.time() - started, 2),
    )


@app.post("/api/v1/production/scene-plan/generate", response_model=PreviewScenePlanGenerateResponse)
async def production_scene_plan_generate(request: PreviewScenePlanGenerateRequest):
    started = time.time()
    scenario_text = str(request.scenario_text or "").strip()
    lyrics_text = str(request.lyrics_text or "").strip()
    world_notes = str(request.world_notes or "").strip()
    arrangement_notes = str(request.arrangement_notes or "").strip()
    scene_count = max(1, min(int(request.scene_count or 5), MAX_PREVIEW_SCENE_COUNT))
    target_duration_sec = max(10, min(int(request.target_duration_sec or 30), 600))
    pipeline_preset_id = str(request.pipeline_preset_id or "").strip()
    workflow_mode = str(request.workflow_mode or "").strip()

    if not any([scenario_text, lyrics_text, world_notes, arrangement_notes]):
        raise HTTPException(status_code=400, detail="scenario or lyrics context is required")

    durations = await _generate_preview_scene_duration_plan(
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        scene_count=scene_count,
        target_duration_sec=target_duration_sec,
        workflow_mode=workflow_mode,
        pipeline_preset_id=pipeline_preset_id,
    )
    transitions, transition_reasons = await _generate_preview_scene_transition_plan(
        scene_count=scene_count,
        scenario_text=scenario_text,
        lyrics_text=lyrics_text,
        world_notes=world_notes,
        arrangement_notes=arrangement_notes,
        durations=durations,
        pipeline_preset_id=pipeline_preset_id,
        workflow_mode=workflow_mode,
    )

    return PreviewScenePlanGenerateResponse(
        success=True,
        scene_count=scene_count,
        scene_durations_sec=durations,
        scene_transitions=transitions,
        scene_transition_reasons=transition_reasons,
        elapsed_time=round(time.time() - started, 2),
    )


@app.post("/api/v1/production/scene-image/generate")
def production_scene_image_generate(request: PreviewSceneImageGenerateRequest):
    started = time.time()
    _set_preview_cancel(request.client_session_id, "scene-image", False)
    scene_index = max(1, int(request.scene_index or 1))
    source_images = [str(item or "").strip() for item in request.input_images][:3]
    source_images = [item for item in source_images if item]
    raw_prompt = str(request.prompt or "").strip()
    prompt = _wrap_qwen_2511_edit_instruction_prompt(raw_prompt) if source_images else raw_prompt
    cfg = max(0.1, min(float(request.cfg or 1.0), 20.0))
    denoise = max(0.0, min(float(request.denoise if request.denoise is not None else 1.0), 1.0))

    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    print(
        "[production] scene-image request",
        {
            "client_session_id": _safe_session_id(request.client_session_id),
            "scene_index": scene_index,
            "source_image_count": len(source_images),
            "prompt_preview": prompt[:240],
        },
    )

    synced_images = [_sync_input_image_to_comfy_input(name, request.client_session_id) for name in source_images]
    workflow_name = _resolve_qwen_2511_workflow_variant(len(synced_images)) if synced_images else "qwen_t2i_2512_lightning4"
    workflow = _load_workflow(workflow_name)
    _apply_basic_parameters(
        workflow,
        input_images=synced_images,
        prompt=prompt,
        cfg=cfg,
        denoise=denoise if synced_images else None,
        steps=4,
    )

    try:
        prompt_id = _queue_prompt_to_comfyui(workflow)
        deadline = time.time() + 300
        outputs: List[Dict[str, Any]] = []
        while time.time() < deadline:
            if _is_preview_cancel_requested(request.client_session_id, "scene-image"):
                _interrupt_comfyui()
                raise HTTPException(status_code=499, detail="Scene image generation canceled")
            try:
                history = _fetch_history(prompt_id)
                outputs = _extract_outputs(history, prompt_id)
            except Exception:
                outputs = []
            if outputs:
                break
            time.sleep(1.2)

        if not outputs:
            raise HTTPException(status_code=504, detail="Scene image generation timed out")

        selected = next((item for item in outputs if str(item.get("media_type")) == "image"), outputs[0])
        preview_url = (
            f"/api/v1/production/media/{_safe_name(str(selected.get('filename') or ''))}"
            f"?client_session_id={_safe_session_id(request.client_session_id)}"
            f"&subfolder={selected.get('subfolder') or ''}"
            f"&type={selected.get('type') or 'output'}"
        )
        return {
            "success": True,
            "scene_index": scene_index,
            "prompt_id": prompt_id,
            "workflow": workflow_name,
            "filename": selected.get("filename"),
            "subfolder": selected.get("subfolder") or "",
            "type": selected.get("type") or "output",
            "media_type": selected.get("media_type") or "image",
            "preview_url": preview_url,
            "elapsed_time": round(time.time() - started, 2),
        }
    finally:
        _set_preview_cancel(request.client_session_id, "scene-image", False)


@app.post("/api/v1/production/scene-video/generate")
def production_scene_video_generate(request: PreviewSceneVideoGenerateRequest):
    started = time.time()
    _set_preview_cancel(request.client_session_id, "scene-video", False)
    scene_index = max(1, int(request.scene_index or 1))
    prompt = str(request.prompt or "").strip()
    image_filename = str(request.image_filename or "").strip()
    end_image_filename = str(request.end_image_filename or "").strip()
    duration_sec = max(1, min(int(request.duration_sec or 5), 15))
    fps = max(8, min(int(request.fps or _default_preview_scene_video_fps(request.workflow_mode)), 32))
    frame_count = _scene_video_frame_count(duration_sec, fps)

    if not image_filename:
        raise HTTPException(status_code=400, detail="image_filename is required")

    workflow_name = _resolve_preview_scene_video_workflow(request.workflow_mode, bool(end_image_filename))
    if workflow_name == "wan22_smooth_first2last" and not end_image_filename:
        workflow_name = "wan22_i2v_lightning"

    input_images = [_sync_input_image_to_comfy_input(image_filename, request.client_session_id)]
    if workflow_name in {"wan22_smooth_first2last", "ltx23_flf"} and end_image_filename:
        input_images.append(_sync_input_image_to_comfy_input(end_image_filename, request.client_session_id))

    negative_prompt = str(request.negative_prompt or "").strip() or _build_preview_scene_video_negative_prompt()
    workflow = _load_workflow(workflow_name)
    if request.audio_off and workflow_name in {"ltx23_i2v", "ltx23_flf"}:
        _disable_ltx_workflow_audio(workflow)
    request_output_suffix = f"scene{scene_index:02d}_{int(started * 1000)}"
    _set_preview_save_prefix_suffix(workflow, request_output_suffix)
    filename_prefixes = _collect_preview_save_prefixes(workflow)
    _apply_basic_parameters(
        workflow,
        input_images=input_images,
        prompt=prompt,
        negative_prompt=negative_prompt,
        fps=fps,
        frames=frame_count,
        cfg=1.0,
        steps=4,
    )

    print(
        "[production] scene-video request",
        {
            "client_session_id": _safe_session_id(request.client_session_id),
            "scene_index": scene_index,
            "workflow": workflow_name,
            "fps": fps,
            "duration_sec": duration_sec,
            "frame_count": frame_count,
            "image_filename": image_filename,
            "end_image_filename": end_image_filename,
            "audio_off": bool(request.audio_off),
            "prompt_preview": prompt[:240],
        },
    )

    try:
        prompt_id = _queue_prompt_to_comfyui(workflow)
        deadline = time.time() + 900
        outputs: List[Dict[str, Any]] = []
        used_recent_fallback = False
        while time.time() < deadline:
            if _is_preview_cancel_requested(request.client_session_id, "scene-video"):
                _interrupt_comfyui()
                raise HTTPException(status_code=499, detail="Scene video generation canceled")
            try:
                history = _fetch_history(prompt_id)
                outputs = _extract_outputs(history, prompt_id)
            except Exception:
                outputs = []
            if not outputs:
                try:
                    history_all = _fetch_history_all()
                    outputs = _extract_outputs(history_all, prompt_id)
                except Exception:
                    outputs = []
            if (time.time() - started) >= 5.0 and not any(str(item.get("media_type") or "") == "video" for item in outputs):
                recent_match = _find_recent_ready_preview_output(
                    media_type="video",
                    started_at=started,
                    prefixes=filename_prefixes,
                    require_prefix=False,
                )
                if recent_match:
                    outputs = outputs + [recent_match]
                    used_recent_fallback = True
            if any(str(item.get("media_type")) == "video" for item in outputs):
                break
            time.sleep(1.5)

        if not outputs:
            print(
                "[production] scene-video timeout",
                {
                    "client_session_id": _safe_session_id(request.client_session_id),
                    "scene_index": scene_index,
                    "workflow": workflow_name,
                    "prompt_id": prompt_id,
                    "prefixes": filename_prefixes,
                    "started_at": started,
                },
            )
            raise HTTPException(status_code=504, detail="Scene video generation timed out")

        selected = next((item for item in outputs if str(item.get("media_type")) == "video"), outputs[0])
        print(
            "[production] scene-video output",
            {
                "scene_index": scene_index,
                "workflow": workflow_name,
                "prompt_id": prompt_id,
                "selected": selected,
                "used_recent_fallback": used_recent_fallback,
                "elapsed_time": round(time.time() - started, 2),
            },
        )
        preview_url = (
            f"/api/v1/production/media/{_safe_name(str(selected.get('filename') or ''))}"
            f"?client_session_id={_safe_session_id(request.client_session_id)}"
            f"&subfolder={selected.get('subfolder') or ''}"
            f"&type={selected.get('type') or 'output'}"
        )
        return {
            "success": True,
            "scene_index": scene_index,
            "prompt_id": prompt_id,
            "workflow": workflow_name,
            "filename": selected.get("filename"),
            "subfolder": selected.get("subfolder") or "",
            "type": selected.get("type") or "output",
            "media_type": selected.get("media_type") or "video",
            "preview_url": preview_url,
            "fps": fps,
            "duration_sec": duration_sec,
            "frame_count": frame_count,
            "elapsed_time": round(time.time() - started, 2),
        }
    finally:
        _set_preview_cancel(request.client_session_id, "scene-video", False)


@app.post("/api/v1/production/final-mv/render")
def production_final_mv_render(request: PreviewFinalMVRenderRequest):
    started = time.time()
    fps = max(8, min(int(request.fps or 16), 32))
    clip_filename = str(request.clip_filename or "").strip()
    audio_filename = str(request.audio_filename or "").strip()
    video_filenames = [str(item or "").strip() for item in request.video_filenames if str(item or "").strip()]
    xfade_transitions = [str(item or "").strip().lower() for item in request.xfade_transitions if str(item or "").strip()]
    xfade_duration = max(0.05, min(float(request.xfade_duration or 0.5), 2.0))

    try:
        if clip_filename:
            clip_path = _resolve_preview_media_source(clip_filename, request.client_session_id)
        else:
            if not video_filenames:
                raise HTTPException(status_code=400, detail="At least one scene video is required")
            resolved_videos = [_resolve_preview_media_source(name, request.client_session_id) for name in video_filenames]
            clip_path = _concat_preview_videos(
                resolved_videos,
                fps=fps,
                xfade_transitions=xfade_transitions,
                xfade_duration=xfade_duration,
            )

        clip_payload = _build_preview_media_payload(clip_path, request.client_session_id, "video")
        final_payload = None
        if audio_filename:
            audio_path = _resolve_preview_media_source(audio_filename, request.client_session_id)
            final_path = _merge_preview_video_with_audio(clip_path, audio_path)
            final_payload = _build_preview_media_payload(final_path, request.client_session_id, "video")
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Final MV render failed: {type(exc).__name__}: {exc}") from exc

    return {
        "success": True,
        "clip_video": clip_payload,
        "final_video": final_payload,
        "audio_filename": audio_filename,
        "elapsed_time": round(time.time() - started, 2),
    }


@app.post("/api/v1/production/vlm/analyze")
async def production_vlm_analyze(request: PreviewVLMAnalyzeRequest):
    started = time.time()
    print(
        "[production] vlm-analyze request",
        {
            "mode": request.mode,
            "language": request.language,
            "focus_area": request.focus_area,
            "image_base64_length": len(str(request.image_base64 or "")),
        },
    )
    try:
        client = _get_vlm_client()
        focus_instruction = f"\n\nPay extra attention to: {request.focus_area.strip()}" if str(request.focus_area or "").strip() else ""
        is_video = str(request.mode or "image").strip().lower() == "video"
        system_role = "You are an expert video prompt generator from image analysis." if is_video else "You are an expert image prompt generator from image analysis."
        base_prompt = "Analyze the image and generate a detailed video prompt in English." if is_video else "Analyze the image and generate a detailed image prompt in English."
        user_prompt = str(request.custom_prompt or (base_prompt + focus_instruction))
        description = await vlm_req(
            client=client,
            user_msg=user_prompt,
            image_base64=request.image_base64,
            role=system_role,
            model=DEFAULT_VLM_MODEL,
            max_tokens=2048,
            temperature=0.3,
        )
        text = str(description or "").strip() or _fallback_vlm_description(request.image_base64, request.mode, request.language, request.focus_area)
    except Exception as exc:
        text = f"{_fallback_vlm_description(request.image_base64, request.mode, request.language, request.focus_area)}\n\n[fallback reason: {type(exc).__name__}: {str(exc)}]"
        print("[production] vlm-analyze fallback", {"error": f"{type(exc).__name__}: {str(exc)}"})
    print(
        "[production] vlm-analyze response",
        {
            "mode": request.mode,
            "language": request.language,
            "elapsed_time": round(time.time() - started, 2),
            "description_length": len(text),
        },
    )
    return {
        "success": True,
        "description": text,
        "mode": request.mode,
        "language": request.language,
        "elapsed_time": round(time.time() - started, 2),
    }


@app.post("/api/v1/production/character-image")
def production_character_image(request: PreviewCharacterImageRequest):
    source_images = [str(item or "").strip() for item in request.input_images][:3]
    source_images = [item for item in source_images if item]
    prompt = _wrap_qwen_2511_edit_instruction_prompt(request.prompt)

    print(
        "[production] character-image request",
        {
            "client_session_id": _safe_session_id(request.client_session_id),
            "source_images": source_images,
            "source_image_count": len(source_images),
            "cfg": request.cfg,
            "denoise": request.denoise,
            "prompt_preview": prompt[:240],
            "prompt_length": len(prompt),
        },
    )

    if not source_images:
        raise HTTPException(status_code=400, detail="At least one input image is required")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    started = time.time()
    synced_images = [_sync_input_image_to_comfy_input(name, request.client_session_id) for name in source_images]
    workflow_name = _resolve_qwen_2511_workflow_variant(len(synced_images))
    print(
        "[production] character-image resolved",
        {
            "workflow": workflow_name,
            "synced_images": synced_images,
        },
    )
    workflow = _load_workflow(workflow_name)
    _apply_basic_parameters(
        workflow,
        input_images=synced_images,
        prompt=prompt,
        cfg=request.cfg,
        denoise=request.denoise,
        steps=4,
    )

    prompt_id = _queue_prompt_to_comfyui(workflow)
    deadline = time.time() + 300
    outputs: List[Dict[str, Any]] = []
    while time.time() < deadline:
        history = _fetch_history(prompt_id)
        outputs = _extract_outputs(history, prompt_id)
        if outputs:
            break
        time.sleep(1.2)

    if not outputs:
        raise HTTPException(status_code=504, detail="Character image generation timed out")

    selected = next((item for item in outputs if str(item.get("media_type")) == "image"), outputs[0])
    print(
        "[production] character-image output",
        {
            "prompt_id": prompt_id,
            "selected": selected,
            "elapsed_time": round(time.time() - started, 2),
        },
    )
    return {
        "success": True,
        "prompt_id": prompt_id,
        "workflow": workflow_name,
        "filename": selected.get("filename"),
        "subfolder": selected.get("subfolder") or "",
        "type": selected.get("type") or "output",
        "media_type": selected.get("media_type") or "image",
        "preview_url": f"/api/v1/production/media/{_safe_name(str(selected.get('filename') or ''))}?client_session_id={_safe_session_id(request.client_session_id)}&subfolder={selected.get('subfolder') or ''}&type={selected.get('type') or 'output'}",
        "elapsed_time": round(time.time() - started, 2),
    }


@app.post("/api/v1/production/character-image/fit-video")
def production_character_image_fit_video(request: PreviewImageFitRequest):
    started = time.time()
    source = _resolve_preview_media_source(request.filename, request.client_session_id)
    output_path = _fit_preview_image_to_canvas(
        source,
        client_session_id=request.client_session_id,
        target_width=request.target_width,
        target_height=request.target_height,
        mode=request.mode,
        anchor_y=request.anchor_y,
    )
    return {
        "success": True,
        "filename": output_path.name,
        "subfolder": "",
        "type": "output",
        "media_type": "image",
        "source_filename": source.name,
        "fit_mode": request.mode,
        "target_width": max(64, min(int(request.target_width or 1280), 4096)),
        "target_height": max(64, min(int(request.target_height or 720), 4096)),
        "preview_url": f"/api/v1/production/media/{_safe_name(output_path.name)}?client_session_id={_safe_session_id(request.client_session_id)}",
        "elapsed_time": round(time.time() - started, 2),
    }


@app.post("/api/v1/production/character-sheet")
def production_character_sheet(request: PreviewCharacterSheetRequest):
    started = time.time()
    workflow_name = "character_sheet_card_v1_0_nobg" if request.nobg else "character_sheet_card_v1_0"
    input_image = _sync_input_image_to_comfy_input(request.source_filename, request.client_session_id)
    print(
        "[production] character-sheet request",
        {
            "client_session_id": _safe_session_id(request.client_session_id),
            "source_filename": request.source_filename,
            "synced_input_image": input_image,
            "workflow": workflow_name,
            "nobg": request.nobg,
        },
    )
    workflow = _load_workflow(workflow_name)
    _apply_basic_parameters(workflow, input_images=[input_image])

    prompt_id = _queue_prompt_to_comfyui(workflow)
    deadline = time.time() + 300
    outputs: List[Dict[str, Any]] = []
    while time.time() < deadline:
        history = _fetch_history(prompt_id)
        outputs = _extract_outputs(history, prompt_id)
        if outputs:
            break
        time.sleep(1.2)

    if not outputs:
        raise HTTPException(status_code=504, detail="Character sheet generation timed out")

    selected = next((item for item in outputs if "CharSheet-CARD" in str(item.get("filename") or "")), None)
    if not selected:
        selected = next((item for item in outputs if str(item.get("media_type")) == "image"), outputs[0])

    print(
        "[production] character-sheet output",
        {
            "prompt_id": prompt_id,
            "selected": selected,
            "elapsed_time": round(time.time() - started, 2),
        },
    )

    return {
        "success": True,
        "prompt_id": prompt_id,
        "workflow": workflow_name,
        "filename": selected.get("filename"),
        "subfolder": selected.get("subfolder") or "",
        "type": selected.get("type") or "output",
        "media_type": selected.get("media_type") or "image",
        "preview_url": f"/api/v1/production/media/{_safe_name(str(selected.get('filename') or ''))}?client_session_id={_safe_session_id(request.client_session_id)}&subfolder={selected.get('subfolder') or ''}&type={selected.get('type') or 'output'}",
        "elapsed_time": round(time.time() - started, 2),
    }


app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
