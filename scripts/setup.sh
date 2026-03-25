#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENV_DIR="$ROOT_DIR/venv"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"

echo "Setting up SlideScribe in $ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but was not found in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH."
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv "$VENV_DIR"
fi

PYTHON_BIN="$VENV_DIR/bin/python3"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$VENV_DIR/bin/python"
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Could not find the virtualenv Python executable."
  exit 1
fi

echo "Installing Python dependencies..."
"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install -r "$ROOT_DIR/requirements.txt"

echo "Installing Node dependencies..."
npm install --prefix "$ROOT_DIR"

if [ ! -f "$ENV_FILE" ] && [ -f "$ENV_EXAMPLE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Created .env from .env.example"
fi

cat <<EOF

Setup complete.

Next steps:
1. Open $ENV_FILE and set GEMINI_API_KEY.
2. Run: npm start

The app will automatically use the repo-local virtual environment at $VENV_DIR.
EOF
