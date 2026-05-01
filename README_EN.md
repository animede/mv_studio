# Music Video Studio

Version: v1.0.0  
License: [MIT](./LICENSE)  
Language: [日本語](./README.md) | English

**Music Video Studio** is a production UI for creating music videos with ComfyUI as the backend. It organizes character design, story/world building, music generation, scene image generation, scene video generation, and final MV rendering into one production canvas.

The default UI is now **Music Video Studio Production**.  
The older `Generative Media Place` / `Simple Video` UI is kept for compatibility.

---

## Overview

The app organizes MV production into these steps:

1. Character creation
2. Story / world building
3. Music creation
4. Scene image creation
5. Scene video creation
6. Final MV rendering

You select a production type and execution plan, then move through the STEP workspace while passing outputs to later steps.

---

## Main Features

- **Production canvas**
  - Canvas name, selected preset, execution plan, selected step, and save state
- **Production type selection**
  - Character-driven MV
  - Lyrics-focused MV
  - Existing-material edit MV
- **Execution plan selection**
  - Character consistency focused plans
  - Scene-by-scene adjustment plans
  - FLF / I2V / mixed-transition plans
- **STEP workspace**
  - Dedicated input, generation, review, and regeneration area for each selected step
- **Character workflow**
  - Reference image slots
  - Character image generation
  - Character sheet generation
  - Non-AI image fitting to video aspect ratio
- **Story / world workflow**
  - Scenario generation via OpenAI-compatible APIs
  - Character context and world notes
- **Music workflow**
  - Lyrics and music plan generation
  - Music generation via ACE-Step API or ComfyUI workflow
  - External audio import and trimming
- **Scene image workflow**
  - Scene prompt generation
  - Scene duration and transition suggestion
  - Batch generation for all scene images
- **Scene video workflow**
  - I2V / FLF / LTX workflows
  - Per-scene video generation
  - Batch generation for all scene videos
- **Final MV workflow**
  - Clip concatenation
  - Audio merge
  - One-click final MV creation from concat to audio merge
- **State persistence**
  - Browser localStorage and server-side session state

---

## Current Notes

- `Auto production`, `STEP production`, and `Edit` currently work mostly as UI modes for labels, guidance, and navigation.
- Full end-to-end auto production is being built incrementally.
- Generation is currently executed through buttons in each STEP.
- ComfyUI defaults to `127.0.0.1:8188`.
- Multi-ComfyUI / multi-worker routing is currently a planning topic. See [docs/MULTI_COMFYUI_WORKER_PLAN_JP.md](docs/MULTI_COMFYUI_WORKER_PLAN_JP.md).

---

## Project Structure

Main files:

```text
mv_studio/
├── app_production.py                 # Production FastAPI app
├── start_production.sh               # Production startup script
├── static/
│   ├── music_video_studio.html       # Production UI
│   ├── js/music_video_studio.js      # Production frontend logic
│   └── css/music_video_studio.css    # Production stylesheet
├── workflows/                        # ComfyUI API workflow JSON files
├── docs/                             # Guides and design notes
├── data/                             # State / reference images / sessions, ignored by git
├── input/                            # Input files, ignored by git
├── output/                           # Output files, ignored by git
└── temp/                             # Temporary files, ignored by git
```

Legacy compatibility UI:

```text
app.py
start.sh
static/index.html
static/js/simple_video.js
```

---

## Requirements

- Python 3.10+
- ComfyUI
- Models and custom nodes required by the ComfyUI API workflows
- ffmpeg
- Browser

Optional:

- OpenAI-compatible API for scenario, prompt, lyrics/music planning, translation, and VLM analysis
- ACE-Step API Server for external music generation

---

## Setup

### 1. Start ComfyUI

Example:

```bash
cd /home/animede/ComfyUI
source /home/animede/comfy-env/bin/activate
python main.py --listen 127.0.0.1 --port 8188
```

Check:

```bash
curl http://127.0.0.1:8188/system_stats
```

### 2. Install app dependencies

```bash
cd /home/animede/mv_studio
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 3. Start the production app

```bash
bash start_production.sh
```

Default URL:

```text
http://127.0.0.1:8091/
```

---

## Startup Options

```bash
bash start_production.sh --host 127.0.0.1 --port 8091
bash start_production.sh --openai-base-url http://127.0.0.1:11434/v1
bash start_production.sh --openai-api-key sk-xxxx
bash start_production.sh --vlm-base-url http://127.0.0.1:11434/v1
bash start_production.sh --vlm-model gemma-3-27b-it
bash start_production.sh --ace-step-url http://127.0.0.1:8001
bash start_production.sh --no-reload
```

Main environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `MV_PRODUCTION_HOST` | Production bind host | `127.0.0.1` |
| `MV_PRODUCTION_PORT` | Production port | `8091` |
| `COMFYUI_SERVER` | ComfyUI server | `127.0.0.1:8188` |
| `COMFYUI_DIR` | ComfyUI root helper | auto-detected |
| `COMFYUI_INPUT_DIR` | ComfyUI input dir | `ComfyUI/input` |
| `COMFYUI_OUTPUT_DIR` | ComfyUI output dir | `ComfyUI/output` |
| `OPENAI_BASE_URL` | OpenAI-compatible API endpoint | optional |
| `OPENAI_API_KEY` | OpenAI-compatible API key | optional |
| `VLM_BASE_URL` | VLM endpoint | follows OpenAI endpoint |
| `VLM_API_KEY` | VLM API key | optional |
| `VLM_MODEL` | VLM model | `gemma-3-27b-it` |
| `ACE_STEP_API_URL` | ACE-Step API Server | optional |

---

## Basic Usage

1. Select a production type from the production canvas.
2. Select a production execution plan.
3. Select a STEP card from the flow.
4. Work through each STEP:
   - Prepare references / character images / character sheets
   - Generate story and world notes
   - Generate lyrics, music plan, and audio
   - Generate scene prompts and scene images
   - Generate scene videos
   - Concatenate clips and merge audio into the final MV

---

## Production API

Main APIs served by `app_production.py`:

| API | Purpose |
|---|---|
| `GET /` | Production UI |
| `GET /music_video_studio.html` | Production UI |
| `GET /api/v1/production/config` | Presets and mode config |
| `GET /api/v1/production/state` | Load state |
| `POST /api/v1/production/state` | Save state |
| `POST /api/v1/production/story/generate` | Generate story |
| `POST /api/v1/production/music/plan` | Generate lyrics/music plan |
| `POST /api/v1/production/music/generate` | Generate music |
| `POST /api/v1/production/scene-image/generate` | Generate scene image |
| `POST /api/v1/production/scene-video/generate` | Generate scene video |
| `POST /api/v1/production/final-mv/render` | Concatenate clips / merge audio |
| `POST /api/v1/production/character-image` | Generate character image |
| `POST /api/v1/production/character-image/fit-video` | Fit image to video aspect ratio |
| `POST /api/v1/production/character-sheet` | Generate character sheet |

---

## Workflows and Models

ComfyUI workflow JSON files are in [workflows](workflows).

Main workflow families:

- Qwen Image / Qwen Image Edit
- Flux / Flux Kontext / Flux2 edit
- Wan2.2 I2V / FLF / T2V
- LTX Video
- ACE-Step 1.5 T2A
- RMBG / remove background
- Video concat / audio merge utilities

Model names, custom nodes, and VRAM requirements depend on your ComfyUI environment and selected workflow. See:

- [docs/TECHNICAL_JP.md](docs/TECHNICAL_JP.md)
- [docs/PIPELINE_CHAR_EDIT_I2I_FLF_JP.md](docs/PIPELINE_CHAR_EDIT_I2I_FLF_JP.md)
- [docs/PIPELINE_CHAR_EDIT_I2I_MIXED_JP.md](docs/PIPELINE_CHAR_EDIT_I2I_MIXED_JP.md)
- [docs/MV_STUDIO_PRESET_MAPPING_JP.md](docs/MV_STUDIO_PRESET_MAPPING_JP.md)

---

## State Persistence

| Storage | Content |
|---|---|
| localStorage `mvStudioProductionState` | Browser UI state |
| localStorage `comfyui_api_client_session_id` | Session ID |
| `data/production_state.json` | Shared server-side state |
| `data/production_sessions/` | Per-session state |
| `data/ref_images/` | Reference images |

`data/`, `input/`, `output/`, `temp/`, and `llm/` are ignored by git.

---

## Legacy UI

The older `Generative Media Place` / `Simple Video` UI is still available:

```bash
bash start.sh
```

Legacy files:

- [app.py](app.py)
- [static/index.html](static/index.html)
- [static/js/simple_video.js](static/js/simple_video.js)

---

## License

[MIT License](./LICENSE)
