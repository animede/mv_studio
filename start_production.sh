#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -z "${VIRTUAL_ENV:-}" ]; then
    for _venv in "$SCRIPT_DIR/.venv" "$SCRIPT_DIR/../.venv"; do
        if [ -f "$_venv/bin/activate" ]; then
            # shellcheck disable=SC1090
            . "$_venv/bin/activate"
            echo "[production] venv activated: $_venv"
            break
        fi
    done
fi

HOST="${MV_PRODUCTION_HOST:-127.0.0.1}"
PORT="${MV_PRODUCTION_PORT:-8091}"
RELOAD_FLAG="--reload"
PYTHON_BIN="${VIRTUAL_ENV:+$VIRTUAL_ENV/bin/python}"

if [ -z "${PYTHON_BIN:-}" ] || [ ! -x "$PYTHON_BIN" ]; then
    for _py in "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/../.venv/bin/python"; do
        if [ -x "$_py" ]; then
            PYTHON_BIN="$_py"
            break
        fi
    done
fi

if [ -z "${PYTHON_BIN:-}" ] || [ ! -x "$PYTHON_BIN" ]; then
    echo "❌ Python executable not found. Activate a venv or install dependencies first." >&2
    exit 1
fi

while [ $# -gt 0 ]; do
    case "$1" in
        -H|--host)
            HOST="${2:-}"
            shift 2
            ;;
        -P|--port)
            PORT="${2:-}"
            shift 2
            ;;
        --openai-base-url)
            export OPENAI_BASE_URL="${2:-}"
            shift 2
            ;;
        --openai-api-key)
            export OPENAI_API_KEY="${2:-}"
            shift 2
            ;;
        --vlm-base-url)
            export VLM_BASE_URL="${2:-}"
            shift 2
            ;;
        --vlm-api-key)
            export VLM_API_KEY="${2:-}"
            shift 2
            ;;
        --vlm-model)
            export VLM_MODEL="${2:-}"
            shift 2
            ;;
        --ace-step-url)
            export ACE_STEP_API_URL="${2:-}"
            shift 2
            ;;
        --reload)
            RELOAD_FLAG="--reload"
            shift
            ;;
        --no-reload)
            RELOAD_FLAG=""
            shift
            ;;
        -h|--help)
            cat <<'EOF'
Usage: ./start_production.sh [options]

Options:
  -H, --host HOST    Bind host (default: 127.0.0.1)
  -P, --port PORT    Bind port (default: 8091)
            --openai-base-url URL  OpenAI-compatible endpoint (sets OPENAI_BASE_URL)
            --openai-api-key KEY   OpenAI API key (sets OPENAI_API_KEY)
            --vlm-base-url URL     VLM endpoint (sets VLM_BASE_URL)
            --vlm-api-key KEY      VLM API key (sets VLM_API_KEY)
            --vlm-model NAME       VLM model name (sets VLM_MODEL)
                        --ace-step-url URL     ACE-Step API server URL (sets ACE_STEP_API_URL)
      --reload       Enable reload (default)
      --no-reload    Disable reload
  -h, --help         Show this help
EOF
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

CMD=("$PYTHON_BIN" -m uvicorn app_production:app --host "$HOST" --port "$PORT")
if [ -n "$RELOAD_FLAG" ]; then
    CMD+=("$RELOAD_FLAG")
fi

echo "[production] host=$HOST port=$PORT reload=$([ -n "$RELOAD_FLAG" ] && echo on || echo off)"
if [ -n "${OPENAI_BASE_URL:-}" ]; then
    echo "[production] OPENAI_BASE_URL=$OPENAI_BASE_URL"
fi
if [ -n "${VLM_BASE_URL:-}" ]; then
    echo "[production] VLM_BASE_URL=$VLM_BASE_URL"
fi
if [ -n "${VLM_MODEL:-}" ]; then
    echo "[production] VLM_MODEL=$VLM_MODEL"
fi
if [ -n "${ACE_STEP_API_URL:-}" ]; then
    echo "[production] ACE_STEP_API_URL=$ACE_STEP_API_URL"
fi
exec "${CMD[@]}"
