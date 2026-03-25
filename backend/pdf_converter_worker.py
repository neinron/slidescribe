from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import random
import shutil
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import fitz
import tiktoken
from dotenv import load_dotenv
from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AsyncOpenAI,
    RateLimitError,
)
from openai.types.chat import ChatCompletionMessageParam

from models import DEFAULT_MODEL, MODEL_LABEL_BY_ID

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PROMPT_PATH = Path(__file__).resolve().parent / "default_system_prompt.txt"

API_MAX_IN_FLIGHT = max(1, int(os.getenv("API_MAX_IN_FLIGHT", "4")))
API_MIN_INTERVAL_SEC = max(0.0, float(os.getenv("API_MIN_INTERVAL_SEC", "0.15")))
IMAGE_DPI = max(72, int(os.getenv("IMAGE_DPI", "110")))
PER_FILE_IN_FLIGHT = max(1, int(os.getenv("PER_FILE_IN_FLIGHT", "4")))
MAX_RAW_TEXT_TOKENS = max(0, int(os.getenv("MAX_RAW_TEXT_TOKENS", "1200")))
MAX_OUTPUT_TOKENS = max(400, int(os.getenv("MAX_OUTPUT_TOKENS", "1400")))
MAX_CONTINUATION_ROUNDS = max(1, int(os.getenv("MAX_CONTINUATION_ROUNDS", "4")))
SAVE_EVERY_PAGES = max(1, int(os.getenv("SAVE_EVERY_PAGES", "3")))
MAX_WORKERS = os.cpu_count() or 4


def load_default_prompt() -> str:
    return DEFAULT_PROMPT_PATH.read_text("utf-8").strip()


def emit(event_type: str, **payload: Any) -> None:
    message = {"type": event_type, **payload}
    print(json.dumps(message, ensure_ascii=False), flush=True)


def load_clients() -> dict[str, AsyncOpenAI]:
    load_dotenv()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
    if not gemini_key or "Wait" in gemini_key:
        raise RuntimeError("No valid Gemini API key found. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env.")

    return {
        "gemini": AsyncOpenAI(
            api_key=gemini_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        )
    }


def page_to_b64(
    pdf_path: Path,
    idx: int,
    remaining_bytes: Optional[int],
    dpi: int = 150,
    min_dpi: int = 60,
) -> tuple[str, int, str]:
    doc = fitz.open(pdf_path)
    try:
        page = doc.load_page(idx)
        cur_dpi = dpi
        last_size = 0
        for _ in range(6):
            pix = page.get_pixmap(dpi=cur_dpi)  # type: ignore[attr-defined]
            png_bytes = pix.tobytes("png")
            last_size = len(png_bytes)
            if remaining_bytes is None or last_size <= remaining_bytes:
                return base64.b64encode(png_bytes).decode(), last_size, page.get_text()
            if cur_dpi <= min_dpi:
                break
            cur_dpi = max(min_dpi, int(cur_dpi * 0.75))

        remaining_mb = 0.0 if remaining_bytes is None else remaining_bytes / 1024 / 1024
        raise RuntimeError(
            f"Image size budget too small for page {idx + 1}. Needed {last_size / 1024 / 1024:.2f} MB, remaining {remaining_mb:.2f} MB."
        )
    finally:
        doc.close()


def message_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
                continue
            text = getattr(part, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "\n".join(parts).strip()
    return ""


def trim_raw_text_for_prompt(page_text: str, max_tokens: int) -> str:
    if max_tokens <= 0:
        return ""
    cleaned = page_text.strip()
    if not cleaned:
        return ""
    try:
        enc = tiktoken.get_encoding("cl100k_base")
        tokens = enc.encode(cleaned)
        if len(tokens) <= max_tokens:
            return cleaned
        return enc.decode(tokens[:max_tokens]).strip() + "\n[raw text truncated]"
    except Exception:
        approx_chars = max_tokens * 4
        if len(cleaned) <= approx_chars:
            return cleaned
        return cleaned[:approx_chars].rstrip() + "\n[raw text truncated]"


def ensure_page_header(markdown: Optional[str], page_number: int) -> str:
    expected = f"## Page {page_number}"
    stripped = (markdown or "").lstrip()
    if stripped.startswith(expected):
        return stripped
    return f"{expected}\n\n{stripped}"


def strip_duplicate_page_header(markdown: str, page_number: int) -> str:
    expected = f"## Page {page_number}"
    stripped = (markdown or "").lstrip()
    if stripped.startswith(expected):
        return stripped[len(expected):].lstrip()
    return stripped


def build_provider_request_kwargs(provider: str) -> dict[str, Any]:
    if provider != "gemini":
        return {}

    extra_body: dict[str, Any] = {}
    gemini_cached_content = os.getenv("GEMINI_CACHED_CONTENT", "").strip()
    gemini_thinking_budget_raw = os.getenv("GEMINI_THINKING_BUDGET", "").strip()
    if gemini_cached_content:
        extra_body["cached_content"] = gemini_cached_content
    if gemini_thinking_budget_raw:
        extra_body["thinking_config"] = {"thinking_budget": int(gemini_thinking_budget_raw)}
    return {"extra_body": extra_body} if extra_body else {}


async def describe_slide_async(
    clients: dict[str, AsyncOpenAI],
    b64_img: str,
    page_text: str,
    model: str,
    page_number: int,
    system_prompt: str,
) -> str:
    if model not in MODEL_LABEL_BY_ID:
        raise RuntimeError(f"Unsupported model '{model}'.")

    client = clients.get("gemini")
    if not client:
        raise RuntimeError("Gemini client is not available. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env.")

    trimmed_page_text = trim_raw_text_for_prompt(page_text, MAX_RAW_TEXT_TOKENS)
    msgs: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": "\n".join(
                [
                    "This is a single, independent slide.",
                    "Do not use or assume any context from other slides.",
                    f"System page number: {page_number}.",
                    f"Mandatory first line of output: ## Page {page_number}",
                    "",
                    "--- RAW TEXT OF CURRENT SLIDE (For Verification) ---",
                    "Use this text only to correct OCR errors in numbers, formulas, and spelling from the image.",
                    "The structure may be noisy, so use the image for layout and hierarchy.",
                    trimmed_page_text or "[no raw text extracted]",
                    "--- End of Raw Text ---",
                ]
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"Convert this PDF page to Markdown. Start with exactly: ## Page {page_number}"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64_img}"}},
            ],
        },
    ]

    assembled_parts: list[str] = []
    continuation_round = 0
    errors = 0
    while True:
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=msgs,
                max_tokens=MAX_OUTPUT_TOKENS,
                timeout=120,
                **build_provider_request_kwargs("gemini"),
            )
            choice = response.choices[0]
            message = choice.message
            raw = message_content_to_text(message.content)
            if not raw.strip():
                refusal = getattr(message, "refusal", None)
                if isinstance(refusal, str) and refusal.strip():
                    raw = f"[unreadable]\n\nModel refusal: {refusal.strip()}"
                else:
                    raw = "[unreadable]\n\nThe model returned an empty response."
            if continuation_round == 0:
                assembled_parts.append(ensure_page_header(raw, page_number))
            else:
                assembled_parts.append(strip_duplicate_page_header(raw, page_number))

            finish_reason = getattr(choice, "finish_reason", None)
            if finish_reason != "length":
                return "\n".join(part.rstrip() for part in assembled_parts if part.strip()).strip()

            continuation_round += 1
            if continuation_round >= MAX_CONTINUATION_ROUNDS:
                emit(
                    "log",
                    level="warn",
                    message=(
                        f"Reached continuation limit for page {page_number}; "
                        "saving partial output. Increase MAX_OUTPUT_TOKENS or MAX_CONTINUATION_ROUNDS if needed."
                    ),
                )
                return "\n".join(part.rstrip() for part in assembled_parts if part.strip()).strip()

            emit(
                "log",
                level="warn",
                message=f"Page {page_number} hit output limit; requesting continuation chunk {continuation_round + 1}.",
            )
            msgs.extend(
                [
                    {"role": "assistant", "content": raw},
                    {
                        "role": "user",
                        "content": (
                            "Continue exactly where you left off. Do not restart, do not repeat earlier text, "
                            "and do not add commentary. Output only the remaining Markdown for this same page."
                        ),
                    },
                ]
            )
            errors = 0
        except (RateLimitError, APIError, APITimeoutError, APIConnectionError) as exc:
            errors += 1
            if errors > 10:
                raise RuntimeError(f"Exceeded max retries for API: {exc}") from exc
            base_delay = min(2.0 * (2**errors), 60)
            delay = base_delay * random.uniform(0.5, 1.5)
            emit("log", level="warn", message=f"API retry {errors}/10 for page {page_number}: {exc}")
            await asyncio.sleep(delay)


@dataclass
class PDFTask:
    id: str
    path: Path
    mode: str
    model: str
    max_bytes: Optional[int]
    pages: int = 0
    done: int = 0
    used_bytes: int = 0
    status: str = "Queued"

    @property
    def progress(self) -> float:
        return 0.0 if self.pages == 0 else self.done / self.pages


class WorkerApp:
    def __init__(self, clients: dict[str, AsyncOpenAI], system_prompt: str):
        self.clients = clients
        self.system_prompt = system_prompt
        self.executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        self.api_sem = asyncio.Semaphore(API_MAX_IN_FLIGHT)
        self.api_start_lock = asyncio.Lock()
        self.next_api_start = 0.0
        self.stop_requested = False

    def stop(self) -> None:
        self.stop_requested = True

    async def _call_model(self, b64_img: str, page_text: str, model: str, page_number: int) -> str:
        async with self.api_sem:
            async with self.api_start_lock:
                now = time.monotonic()
                if now < self.next_api_start:
                    await asyncio.sleep(self.next_api_start - now)
                    now = time.monotonic()
                self.next_api_start = now + API_MIN_INTERVAL_SEC
            return await describe_slide_async(
                self.clients,
                b64_img,
                page_text,
                model,
                page_number,
                self.system_prompt,
            )

    async def _fetch_image(self, task: PDFTask, idx: int) -> tuple[str, int, str]:
        remaining = None
        if task.max_bytes is not None:
            remaining = task.max_bytes - task.used_bytes
            if remaining <= 0:
                raise RuntimeError("Image size budget exceeded.")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.executor, page_to_b64, task.path, idx, remaining, IMAGE_DPI)

    async def process_task(self, task: PDFTask) -> None:
        task.status = "Preparing"
        emit("task_update", taskId=task.id, status=task.status, progress=task.progress, pages=0, done=0)
        with fitz.open(task.path) as doc:
            task.pages = len(doc)

        progress_dir = ROOT_DIR / "pdf_converter_progress"
        progress_dir.mkdir(exist_ok=True)
        md_path = task.path.parent / f"{task.path.stem}_llm_description.md"
        path_hash = hashlib.md5(str(task.path.resolve()).encode("utf-8")).hexdigest()[:8]
        json_path = progress_dir / f"{task.path.stem}_{path_hash}_progress.json"

        if not json_path.exists():
            suffix = "_progress.json"
            candidates: list[Path] = []
            for file in progress_dir.iterdir():
                if not file.name.endswith(suffix) or file.name == json_path.name:
                    continue
                base = file.name[: -len(suffix)]
                candidate_stem, sep, candidate_hash = base.rpartition("_")
                if sep == "_" and len(candidate_hash) == 8 and candidate_stem == task.path.stem:
                    candidates.append(file)
            if candidates:
                candidates.sort(key=lambda file: file.stat().st_mtime, reverse=True)
                shutil.copy(str(candidates[0]), str(json_path))
                emit("log", level="info", message=f"Imported existing progress for {task.path.name}")

        descriptions: list[Optional[str]] = [None] * task.pages
        if json_path.exists():
            try:
                raw = json.loads(json_path.read_text("utf-8"))
                if isinstance(raw, list) and len(raw) == task.pages:
                    descriptions = raw
                    task.done = sum(1 for item in descriptions if item)
            except Exception:
                emit("log", level="warn", message=f"Failed to read progress file for {task.path.name}; starting fresh.")

        unsaved_pages = 0

        def save_progress(force: bool = False) -> None:
            nonlocal unsaved_pages
            if not force and unsaved_pages < SAVE_EVERY_PAGES:
                return
            md_text = "\n\n".join(item for item in descriptions if item)
            md_path.write_text(md_text, "utf-8")
            json_path.write_text(json.dumps(descriptions, ensure_ascii=False, indent=2), "utf-8")
            unsaved_pages = 0

        task.status = "Running"
        emit("task_update", taskId=task.id, status=task.status, progress=task.progress, pages=task.pages, done=task.done)
        emit("log", level="info", message=f"Processing {task.path.name} in {task.mode} mode")

        try:
            if task.mode == "parallel":
                pending_idxs = [idx for idx in range(task.pages) if not descriptions[idx]]

                async def process_page(idx: int) -> tuple[int, str, int]:
                    b64, size, page_text = await self._fetch_image(task, idx)
                    text = await self._call_model(b64, page_text, task.model, idx + 1)
                    return idx, text, size

                in_flight: dict[asyncio.Task[tuple[int, str, int]], int] = {}
                completed: dict[int, tuple[str, int]] = {}
                launch_ptr = 0
                commit_ptr = 0

                while launch_ptr < len(pending_idxs) and len(in_flight) < PER_FILE_IN_FLIGHT:
                    idx = pending_idxs[launch_ptr]
                    launch_ptr += 1
                    future = asyncio.create_task(process_page(idx))
                    in_flight[future] = idx

                while in_flight:
                    if self.stop_requested:
                        raise asyncio.CancelledError()

                    done_set, _ = await asyncio.wait(set(in_flight.keys()), return_when=asyncio.FIRST_COMPLETED)
                    for future in done_set:
                        idx = in_flight.pop(future)
                        page_idx, text, size = future.result()
                        completed[page_idx] = (text, size)
                        emit("log", level="info", message=f"Rendered page {idx + 1} for {task.path.name}")

                    while launch_ptr < len(pending_idxs) and len(in_flight) < PER_FILE_IN_FLIGHT:
                        idx = pending_idxs[launch_ptr]
                        launch_ptr += 1
                        future = asyncio.create_task(process_page(idx))
                        in_flight[future] = idx

                    while commit_ptr < len(pending_idxs):
                        idx = pending_idxs[commit_ptr]
                        if idx not in completed:
                            break
                        text, size = completed.pop(idx)
                        descriptions[idx] = text
                        task.used_bytes += size
                        task.done += 1
                        unsaved_pages += 1
                        save_progress()
                        emit(
                            "task_update",
                            taskId=task.id,
                            status=task.status,
                            progress=task.progress,
                            pages=task.pages,
                            done=task.done,
                        )
                        emit("page_done", taskId=task.id, page=idx + 1, pages=task.pages)
                        commit_ptr += 1
            else:
                start_idx = 0
                while start_idx < task.pages and descriptions[start_idx]:
                    start_idx += 1
                next_img_task: Optional[asyncio.Task[tuple[str, int, str]]] = None
                if start_idx < task.pages:
                    next_img_task = asyncio.create_task(self._fetch_image(task, start_idx))

                for idx in range(start_idx, task.pages):
                    if self.stop_requested:
                        raise asyncio.CancelledError()
                    if next_img_task is None:
                        break
                    b64, size, page_text = await next_img_task
                    task.used_bytes += size
                    if idx + 1 < task.pages:
                        next_img_task = asyncio.create_task(self._fetch_image(task, idx + 1))
                    else:
                        next_img_task = None
                    descriptions[idx] = await self._call_model(b64, page_text, task.model, idx + 1)
                    task.done += 1
                    unsaved_pages += 1
                    save_progress()
                    emit(
                        "task_update",
                        taskId=task.id,
                        status=task.status,
                        progress=task.progress,
                        pages=task.pages,
                        done=task.done,
                    )
                    emit("page_done", taskId=task.id, page=idx + 1, pages=task.pages)

            save_progress(force=True)
            task.status = "Done"
            emit("task_update", taskId=task.id, status=task.status, progress=1.0, pages=task.pages, done=task.done)
        except asyncio.CancelledError:
            task.status = "Stopped"
            save_progress(force=True)
            emit("task_update", taskId=task.id, status=task.status, progress=task.progress, pages=task.pages, done=task.done)
            raise
        except Exception as exc:
            task.status = "Error"
            save_progress(force=True)
            emit(
                "task_update",
                taskId=task.id,
                status=task.status,
                progress=task.progress,
                pages=task.pages,
                done=task.done,
                error=str(exc),
            )
            raise

    async def process_all(self, tasks: list[PDFTask]) -> str:
        status = "completed"
        emit("run_started", taskCount=len(tasks))
        for task in tasks:
            if self.stop_requested:
                status = "stopped"
                break
            try:
                await self.process_task(task)
            except asyncio.CancelledError:
                status = "stopped"
                break
            except Exception as exc:
                status = "failed"
                emit("log", level="error", message=f"Failed {task.path.name}: {exc}")
        emit("run_finished", status=status)
        return status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to a JSON config file")
    return parser.parse_args()


def build_tasks(config: dict[str, Any]) -> list[PDFTask]:
    tasks: list[PDFTask] = []
    max_mb = float(config.get("maxMb", 0) or 0)
    max_bytes = int(max_mb * 1024 * 1024) if max_mb > 0 else None
    mode = "parallel" if config.get("mode") == "parallel" else "sequential"
    model = str(config.get("model") or DEFAULT_MODEL)

    for raw_task in config.get("tasks", []):
        task_path = Path(raw_task["path"]).expanduser().resolve()
        tasks.append(
            PDFTask(
                id=str(raw_task["id"]),
                path=task_path,
                mode=mode,
                model=model,
                max_bytes=max_bytes,
            )
        )
    return tasks


async def async_main() -> int:
    args = parse_args()
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text("utf-8"))
    system_prompt = str(config.get("systemPrompt") or load_default_prompt()).strip()
    if not system_prompt:
        raise RuntimeError("System prompt cannot be empty.")

    clients = load_clients()
    app = WorkerApp(clients, system_prompt)

    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        if hasattr(signal, signame):
            try:
                loop.add_signal_handler(getattr(signal, signame), app.stop)
            except NotImplementedError:
                pass

    tasks = build_tasks(config)
    if not tasks:
        raise RuntimeError("No PDF tasks provided.")

    status = await app.process_all(tasks)
    app.executor.shutdown(wait=False, cancel_futures=True)
    return 0 if status in {"completed", "stopped"} else 1


def main() -> int:
    try:
        return asyncio.run(async_main())
    except Exception as exc:
        emit("fatal_error", message=str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
