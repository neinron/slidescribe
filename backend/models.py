from __future__ import annotations

import os

DEFAULT_MODEL = (
    os.getenv("GEMINI_MODEL", "").strip()
    or os.getenv("OPENAI_MODEL", "").strip()
    or "gemini-2.5-flash"
)

MODEL_OPTIONS: list[tuple[str, str]] = [
    ("gemini-2.5-flash", "gemini-2.5-flash ($0.30 in / $2.50 out per 1M)"),
    ("gemini-2.5-flash-lite", "gemini-2.5-flash-lite ($0.10 in / $0.40 out per 1M)"),
    ("gemini-2.5-pro", "gemini-2.5-pro ($1.25 in / $10.00 out per 1M)"),
    ("gemini-3.1-pro-preview", "gemini-3.1-pro-preview ($1.50 in / $12.00 out per 1M, <=200k)"),
    ("gemini-3-flash-preview", "gemini-3-flash-preview ($0.30 in / $2.50 out per 1M)"),
    ("gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite-preview ($0.10 in / $0.40 out per 1M)"),
    ("gemini-flash-latest", "gemini-flash-latest (alias, dynamic pricing)"),
]

if DEFAULT_MODEL not in {model_id for model_id, _label in MODEL_OPTIONS}:
    DEFAULT_MODEL = "gemini-2.5-flash"

MODEL_LABEL_BY_ID = {model_id: label for model_id, label in MODEL_OPTIONS}
MODEL_ID_BY_LABEL = {label: model_id for model_id, label in MODEL_OPTIONS}
