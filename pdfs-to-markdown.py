"""GUI tool that converts university lecture PDFs to structured Markdown using GPT‑4o‑vision.

Key features
------------
* **Parallel Mode**: Process all slides simultaneously (Fast, uses raw text context).
* **Sequential Mode**: Context-aware processing with image pre-fetching (Slower, higher quality).
* **Async I/O**: Non-blocking network calls for maximum throughput.
* **Live log window**: progress, errors.
* **Resume support**: continues partially processed PDFs.

Run: `python pdfs-to-markdown.py`
"""

# ───────────────────────────── Python Version Check ─────────────────────────────
import sys

if sys.version_info < (3, 10):
    print("❗ Python 3.10 or newer is required. Please install a newer Python version.")
    exit(1)


# ───────────────────────────── Optional Dependency Check ─────────────────────────────
REQUIRED = {
    "openai": "openai",
    "python-dotenv": "dotenv",
    "PyMuPDF": "fitz",
    "tiktoken": "tiktoken",
}

missing = []
for pkg, imp in REQUIRED.items():
    try:
        __import__(imp, globals(), locals(), [], 0)
    except ModuleNotFoundError:
        missing.append(pkg)
if missing:
    print(f"\n❗ Missing packages: {', '.join(missing)}")
    print("👉 Please install them with:")
    print("   pip install -r requirements.txt\n")
    exit(1)


import asyncio
import base64
import json
import hashlib
import os
import queue
import shutil
import threading
import time
from concurrent.futures import Future as CFuture, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional, Tuple, cast, List

import fitz  # PyMuPDF
import tiktoken
from dotenv import load_dotenv
from openai import (
    AsyncOpenAI,
    APIConnectionError,
    APIError,
    APITimeoutError,
    RateLimitError,
)
from openai.types.chat import ChatCompletionMessageParam
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# ───────────────────────────── .env file check ─────────────────────────────
if not os.path.exists(".env"):
    if os.path.exists(".env.example"):
        shutil.copy(".env.example", ".env")
        print(
            "\n⚠️  No .env file found. Created one from .env.example. Please add your OpenAI API key to the .env file before running again.\n"
        )
    else:
        with open(".env", "w") as f:
            f.write(
                "OPENAI_API_KEY=sk-...\n"
                "GEMINI_API_KEY=...\n"
                "GOOGLE_API_KEY=...\n"
                "# Optional: Default model (gemini-2.5-flash, gemini-2.5-pro, gpt-5-mini)\n"
                "OPENAI_MODEL=gemini-2.5-flash\n"
            )
        print(
            "\n⚠️  No .env file found. Created a new .env file. Please add your OpenAI API key to the .env file before running again.\n"
        )
    exit(1)

SYSTEM_PROMPT = (
    """
You convert a single PDF page image into faithful Markdown.

Goal:
- Produce clean Markdown that preserves the page content in natural reading order.
- Transcribe text, formulas, tables, captions, and meaningful visual information.
- Keep the output useful for studying and search.
- Do not invent a rigid template that is not present on the page.

Requirements:
1. Start with exactly:
   ## Page <PAGE_NUMBER>

2. Preserve the page's actual structure.
   - If the page has a title, headings, bullets, numbered items, or sections, keep them.
   - If the page is mostly continuous prose, output continuous prose.
   - Do not force sections like "Layout", "Text", "Equations", "Figures", or "Coverage check" unless the page itself effectively contains such structure.

3. Write in reading order.
   - Merge text and related equations or figures where they belong.
   - Do not sort content into artificial buckets.

4. Focus on slide content, not repeated slide furniture.
   - Ignore recurring logos, university branding, page numbers, decorative lines, repeated headers, repeated footers, copyright notices, and repeated navigation elements.
   - Ignore repeated footnotes or boilerplate that appear on most or all slides unless they contain page-specific academic content.
   - Only include such elements if they are clearly relevant to understanding this specific page.

5. Equations:
   - Transcribe equations in LaTeX using Markdown math.
   - Use block math for standalone displayed equations.
   - Keep equation labels if present.
   - Do not add explanations unless the page itself provides them.

6. Tables:
   - Recreate tables as Markdown tables when possible.
   - If a table is too complex for a simple Markdown table, describe its structure faithfully and compactly.

7. Figures and diagrams:
   - Do not use Markdown image syntax.
   - If a figure contains essential information, describe it briefly and precisely near its caption or point of reference.
   - Do not force a multi-part schema like "A) Components, B) Geometry..."
   - Describe only what is necessary to preserve the meaning of the figure.

8. OCR correction:
   - Use the provided raw page text only to correct unclear words, formulas, or symbols.
   - Use the image as the source of truth for layout and hierarchy.

9. Unclear content:
   - If something is unreadable, mark it as [unreadable] at the relevant spot.
   - Never guess.

10. Output only the final Markdown for that page.
   - No commentary about the task.
   - No quality checklist.
   - No self-evaluation.
"""
)

# ───────────────────────────── Setup OpenAI ──────────────────────────────
load_dotenv()

# ───────────────────────────── Configuration ────────────────────────────
# ───────────────────────────── Configuration ────────────────────────────
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gemini-2.5-flash").strip()

# Prices are USD per 1M input/output tokens (as of 2026-03-04).
MODEL_OPTIONS: list[tuple[str, str]] = [
    ("gemini-2.5-flash", "gemini-2.5-flash ($0.30 in / $2.50 out per 1M)"),
    ("gemini-2.5-flash-lite", "gemini-2.5-flash-lite ($0.10 in / $0.40 out per 1M)"),
    ("gemini-2.5-pro", "gemini-2.5-pro ($1.25 in / $10.00 out per 1M)"),
    ("gpt-5.2", "gpt-5.2 ($1.75 in / $14.00 out per 1M)"),
    ("gpt-5-mini", "gpt-5-mini ($0.25 in / $2.00 out per 1M)"),
    ("gpt-5-nano", "gpt-5-nano ($0.05 in / $0.40 out per 1M)"),
    ("gpt-4o", "gpt-4o ($2.50 in / $10.00 out per 1M)"),
    ("gpt-4o-mini", "gpt-4o-mini ($0.15 in / $0.60 out per 1M)"),
    ("gemini-3.1-pro-preview", "gemini-3.1-pro-preview ($1.50 in / $12.00 out per 1M, <=200k)"),
    ("gemini-3-flash-preview", "gemini-3-flash-preview ($0.30 in / $2.50 out per 1M)"),
    ("gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite-preview ($0.10 in / $0.40 out per 1M)"),
    ("gemini-flash-latest", "gemini-flash-latest (alias, dynamic pricing)"),
]
MODEL_LABEL_BY_ID = {model_id: label for model_id, label in MODEL_OPTIONS}
MODEL_ID_BY_LABEL = {label: model_id for model_id, label in MODEL_OPTIONS}
MODEL_LABELS = [label for _, label in MODEL_OPTIONS]
DEFAULT_MODEL_LABEL = MODEL_LABEL_BY_ID.get(DEFAULT_MODEL, DEFAULT_MODEL)
MAX_WORKERS = os.cpu_count() or 4
API_MAX_IN_FLIGHT = max(1, int(os.getenv("API_MAX_IN_FLIGHT", "4")))
API_MIN_INTERVAL_SEC = max(0.0, float(os.getenv("API_MIN_INTERVAL_SEC", "0.15")))
IMAGE_DPI = max(72, int(os.getenv("IMAGE_DPI", "110")))
PER_FILE_IN_FLIGHT = max(1, int(os.getenv("PER_FILE_IN_FLIGHT", "4")))
MAX_RAW_TEXT_TOKENS = max(0, int(os.getenv("MAX_RAW_TEXT_TOKENS", "1200")))
MAX_OUTPUT_TOKENS = max(400, int(os.getenv("MAX_OUTPUT_TOKENS", "1400")))
SAVE_EVERY_PAGES = max(1, int(os.getenv("SAVE_EVERY_PAGES", "3")))

openai_key = os.getenv("OPENAI_API_KEY", "").strip()
gemini_key = os.getenv("GEMINI_API_KEY", "").strip() or os.getenv("GOOGLE_API_KEY", "").strip()
gemini_cached_content = os.getenv("GEMINI_CACHED_CONTENT", "").strip()
_gemini_thinking_budget_raw = os.getenv("GEMINI_THINKING_BUDGET", "").strip()
gemini_thinking_budget: Optional[int] = (
    int(_gemini_thinking_budget_raw) if _gemini_thinking_budget_raw else None
)

clients = {}

if openai_key and "sk-" in openai_key:
    clients["openai"] = AsyncOpenAI(api_key=openai_key)

if gemini_key and "Wait" not in gemini_key: # Basic check
    clients["gemini"] = AsyncOpenAI(
        api_key=gemini_key,
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
    )

if not clients:
    print("\n❗ No valid API keys found (OpenAI or Gemini).")
    print("👉 Please update your .env file with GEMINI_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY.\n")
    exit(1)

# Helper to map UI model names to actual API model IDs
def get_model_id(ui_model_name: str) -> str:
    # Google models usage with OpenAI client:
    # Google API expects model names like "gemini-1.5-flash" directly.
    # We pass them through as-is, but ensure we don't send weird "latest" aliases that might be deprecated.
    return ui_model_name


# ───────────────────────────── PDF helper (Sync) ─────────────────────────
# PyMuPDF is synchronous and CPU bound. We will run this in executor.
def page_to_b64(
    pdf_path: Path,
    idx: int,
    remaining_bytes: Optional[int],
    dpi: int = 150,
    min_dpi: int = 60,
) -> Tuple[str, int, str]:
    # We must open a NEW document object for thread safety when using threads,
    # or just use the one passed if careful. Ideally separate handles for separate threads.
    # Here we open fresh to be safe in thread pool.
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
        
        # If we failed to fit in budget
        remaining_mb = 0.0 if remaining_bytes is None else remaining_bytes / 1024 / 1024
        raise RuntimeError(
            f"Image size budget too small for page {idx + 1}. Needed {last_size / 1024 / 1024:.2f} MB, remaining {remaining_mb:.2f} MB."
        )
    finally:
        doc.close()


# ───────────────────────────── Async Logic ───────────────────────────────
def ensure_page_header(markdown: Optional[str], page_number: int) -> str:
    expected = f"## Page {page_number}"
    stripped = (markdown or "").lstrip()
    if stripped.startswith(expected):
        return stripped
    return f"{expected}\n\n{stripped}"


def message_content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                txt = part.get("text")
                if isinstance(txt, str):
                    parts.append(txt)
                continue
            txt = getattr(part, "text", None)
            if isinstance(txt, str):
                parts.append(txt)
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


def build_provider_request_kwargs(provider: str) -> dict[str, Any]:
    if provider != "gemini":
        return {}

    # The Google OpenAI-compatible endpoint is stricter than the native Gemini API.
    # Only pass optional extension fields when the user explicitly configured them.
    extra_body: dict[str, Any] = {}
    if gemini_cached_content:
        extra_body["cached_content"] = gemini_cached_content
    if gemini_thinking_budget is not None:
        extra_body["thinking_config"] = {"thinking_budget": gemini_thinking_budget}
    return {"extra_body": extra_body} if extra_body else {}


async def describe_slide_async(b64_img: str, page_text: str, model: str, page_number: int) -> str:
    # Determine provider
    provider = "gemini" if "gemini" in model.lower() else "openai"
    client = clients.get(provider)
    
    if not client:
        raise RuntimeError(f"Model '{model}' selected but {provider.upper()}_API_KEY is missing/invalid.")

    trimmed_page_text = trim_raw_text_for_prompt(page_text, MAX_RAW_TEXT_TOKENS)
    msgs: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": SYSTEM_PROMPT},
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
                {
                    "type": "text", 
                    "text": f"Convert this PDF page to Markdown. Start with exactly: ## Page {page_number}"
                },
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64_img}"},
                }
            ],
        },
    ]
    
    # Simple exponential backoff retry loop
    import random
    errors = 0
    while True:
        try:
            resp = await client.chat.completions.create(
                model=get_model_id(model),
                messages=msgs,
                max_tokens=MAX_OUTPUT_TOKENS,
                timeout=120,
                **build_provider_request_kwargs(provider),
            )
            msg = resp.choices[0].message
            raw = message_content_to_text(msg.content)
            if not raw.strip():
                refusal = getattr(msg, "refusal", None)
                if isinstance(refusal, str) and refusal.strip():
                    raw = f"### Callouts and side notes\n- [unreadable] Model refusal: {refusal.strip()}"
                else:
                    raw = "### Coverage check\n- All text transcribed: no\n- All equations captured: no\n- All tables captured: no\n- All figures described in text: no\n- Any unreadable parts: full page output missing from model response"
            return ensure_page_header(raw, page_number)
        except (RateLimitError, APIError, APITimeoutError, APIConnectionError) as e:
            errors += 1
            if errors > 10:
                raise RuntimeError(f"Exceeded max retries for API: {e}")
            
            base_delay = min(2.0 * (2 ** errors), 60)
            delay = base_delay * random.uniform(0.5, 1.5)
            
            err_msg = str(e).split('Please try again')[0] if 'Please try again' in str(e) else str(e)
            print(f"⚠️ API Error ({model}) Retry {errors}/10: {err_msg[:100]}... Waiting {delay:.1f}s")
            await asyncio.sleep(delay)


class PDFTask:
    def __init__(self, path: Path):
        self.path = path
        self.pages = 0
        self.done = 0
        self.status = "Queued"
        self.out_dir: Optional[Path] = None
        self.max_bytes: Optional[int] = None
        self.used_bytes = 0
        self.mode = "parallel" # 'parallel' or 'sequential'
        self.model = DEFAULT_MODEL

    @property
    def progress(self):
        return 0 if self.pages == 0 else self.done / self.pages


class AsyncAppLogic:
    def __init__(self, log_func, update_func, blocking_executor):
        self.log = log_func
        self.update_row = update_func
        self.executor = blocking_executor
        self._api_sem: Optional[asyncio.Semaphore] = None
        self._api_start_lock: Optional[asyncio.Lock] = None
        self._next_api_start = 0.0

    async def _call_model(self, b64_img: str, page_text: str, model: str, page_number: int) -> str:
        if self._api_sem is None:
            self._api_sem = asyncio.Semaphore(API_MAX_IN_FLIGHT)
        if self._api_start_lock is None:
            self._api_start_lock = asyncio.Lock()

        # Global concurrency cap across all PDFs/tasks.
        async with self._api_sem:
            # Global pacing so request starts are spread out and don't burst.
            async with self._api_start_lock:
                now = time.monotonic()
                if now < self._next_api_start:
                    await asyncio.sleep(self._next_api_start - now)
                    now = time.monotonic()
                self._next_api_start = now + API_MIN_INTERVAL_SEC
            return await describe_slide_async(b64_img, page_text, model, page_number)
    
    async def process_task(self, task: PDFTask):
        try:
            self.log(f"⚙️ Processing {task.path.name} ({task.mode.title()} Mode)")
            
            # Open doc briefly to get page count
            with fitz.open(task.path) as doc:
                task.pages = len(doc)
            
            # ───────────────────────────── Storage Setup ─────────────────────────────
            # 1. Global Progress Folder (in the script's directory)
            script_dir = Path(__file__).parent
            progress_dir = script_dir / "pdf_converter_progress"
            progress_dir.mkdir(exist_ok=True)

            # 2. Markdown Output (next to the original PDF)
            md_path = task.path.parent / f"{task.path.stem}_llm_description.md"

            # 3. Unique Progress JSON (to avoid collisions if files have same name)
            # We hash the absolute path of the PDF to get a unique suffix
            path_hash = hashlib.md5(str(task.path.resolve()).encode("utf-8")).hexdigest()[:8]
            json_filename = f"{task.path.stem}_{path_hash}_progress.json"
            json_path = progress_dir / json_filename

            # Fallback: Check for displaced progress files by filename stem (if exact match missing)
            if not json_path.exists():
                try:
                    candidates = []
                    suffix = "_progress.json"
                    target_stem = task.path.stem
                    
                    for f in progress_dir.iterdir():
                        if f.name.endswith(suffix) and f.name != json_filename:
                            # Expected format: {stem}_{hash8}_progress.json
                            base = f.name[:-len(suffix)]
                            candidate_stem, sep, candidate_hash = base.rpartition("_")
                            
                            # Check if stem matches and hash looks valid (8 chars)
                            if sep == "_" and len(candidate_hash) == 8 and candidate_stem == target_stem:
                                candidates.append(f)
                    
                    if candidates:
                        # Use most recently modified
                        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        best_match = candidates[0]
                        self.log(f"🔎 Found existing progress for '{target_stem}' from another location. Importing...")
                        shutil.copy(str(best_match), str(json_path))
                        self.log(f"   ✅ Adopted progress from {best_match.name}")

                except Exception as e:
                    print(f"Fallback check failed: {e}")

            # Load existing
            desc: list[Optional[str]] = [None] * task.pages
            if json_path.exists():
                try:
                    raw = json.loads(json_path.read_text("utf-8"))
                    if len(raw) == task.pages:
                        desc = raw
                        task.done = sum(1 for d in desc if d)
                except Exception:
                    pass
            
            self.update_row(task)

            unsaved_pages = 0

            # Helper to save
            def save_progress(force: bool = False):
                nonlocal unsaved_pages
                if not force and unsaved_pages < SAVE_EVERY_PAGES:
                    return
                md_text = "\n\n".join(d for d in desc if d)
                md_path.write_text(md_text, "utf-8")
                json_path.write_text(json.dumps(desc, ensure_ascii=False, indent=2), "utf-8")
                unsaved_pages = 0
                self.update_row(task)

            # --- Image Fetcher Helper ---
            async def fetch_image(idx: int) -> Tuple[str, int, str]:
                # Calculate budget
                remaining = None
                if task.max_bytes is not None:
                    remaining = task.max_bytes - task.used_bytes
                    if remaining <= 0:
                        raise RuntimeError("Image size budget exceeded.")
                
                # Run CPU bound task in thread pool
                loop = asyncio.get_running_loop()
                b64, size, page_text = await loop.run_in_executor(
                    self.executor, page_to_b64, task.path, idx, remaining, IMAGE_DPI
                )
                return b64, size, page_text

            # --- PARALLEL MODE ---
            if task.mode == "parallel":
                self.log(
                    f"ℹ️ Ordered concurrent mode: submitting up to {PER_FILE_IN_FLIGHT} pages in-flight."
                )
                pending_idxs = [i for i in range(task.pages) if not desc[i]]
                if pending_idxs:
                    async def process_page(idx: int) -> Tuple[int, str, int]:
                        b64, size, page_text = await fetch_image(idx)
                        txt = await self._call_model(b64, page_text, task.model, idx + 1)
                        return idx, txt, size

                    in_flight: dict[asyncio.Task[Tuple[int, str, int]], int] = {}
                    completed: dict[int, Tuple[str, int]] = {}
                    launch_ptr = 0
                    commit_ptr = 0

                    while launch_ptr < len(pending_idxs) and len(in_flight) < PER_FILE_IN_FLIGHT:
                        idx = pending_idxs[launch_ptr]
                        launch_ptr += 1
                        fut = asyncio.create_task(process_page(idx))
                        in_flight[fut] = idx

                    while in_flight:
                        done_set, _ = await asyncio.wait(
                            set(in_flight.keys()), return_when=asyncio.FIRST_COMPLETED
                        )

                        for fut in done_set:
                            idx = in_flight.pop(fut)
                            try:
                                page_idx, txt, size = fut.result()
                                completed[page_idx] = (txt, size)
                            except Exception as e:
                                self.log(f"❌ Error on slide {idx + 1}: {e}")

                        while launch_ptr < len(pending_idxs) and len(in_flight) < PER_FILE_IN_FLIGHT:
                            idx = pending_idxs[launch_ptr]
                            launch_ptr += 1
                            fut = asyncio.create_task(process_page(idx))
                            in_flight[fut] = idx

                        # Commit strictly in front-to-back order.
                        while commit_ptr < len(pending_idxs):
                            idx = pending_idxs[commit_ptr]
                            if idx not in completed:
                                break
                            txt, size = completed.pop(idx)
                            desc[idx] = txt
                            task.used_bytes += size
                            task.done += 1
                            unsaved_pages += 1
                            self.update_row(task)
                            save_progress()
                            self.log(f"✅ Slide {idx + 1}/{task.pages} done")
                            commit_ptr += 1

            # --- SEQUENTIAL MODE ---
            else:
                # Pre-fetch pipeline key:
                # We need image for N+1 while processing N.
                
                # Fetch first image
                next_img_task = None
                
                # Find first incomplete
                start_idx = 0
                while start_idx < task.pages and desc[start_idx]:
                    start_idx += 1
                
                if start_idx < task.pages:
                    # Start fetching first needed image
                    next_img_task = asyncio.create_task(fetch_image(start_idx))

                for idx in range(start_idx, task.pages):
                    # 1. Await image result from background task
                    if not next_img_task:
                        break # Should not happen
                    
                    b64, size, page_text = await next_img_task
                    task.used_bytes += size
                    
                    # 2. Start fetching NEXT image in background immediately
                    if idx + 1 < task.pages:
                        next_img_task = asyncio.create_task(fetch_image(idx + 1))
                    else:
                        next_img_task = None

                    # 3. Call LLM with only the current slide data
                    txt = await self._call_model(b64, page_text, task.model, idx + 1)
                    desc[idx] = txt
                    task.done += 1
                    unsaved_pages += 1
                    self.update_row(task)
                    save_progress()
                    self.log(f"✅ Slide {idx + 1}/{task.pages} done")

            save_progress(force=True)
            task.status = "Done"
            self.update_row(task)
            self.log(f"🏁 Finished {task.path.name}")

        except asyncio.CancelledError:
            task.status = "Stopped"
            self.update_row(task)
            self.log(f"⏹️ Stopped {task.path.name}")
            raise
        except Exception as e:
            task.status = f"Error: {str(e)}"[:28]
            self.update_row(task)
            import traceback
            self.log(f"❌ Error in {task.path.name}: {e}")
            print(traceback.format_exc())


# ───────────────────────────── GUI Class ────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Lecture‑to‑LLM Converter (Async/Parallel)")
        self.geometry("900x680")
        self.tasks: list[PDFTask] = []
        
        # Thread pool for CPU bound stuff (image rendering)
        self.cpu_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        
        # Communication with Async Loop
        self.gui_q: "queue.Queue[Callable[[], None]]" = queue.Queue()
        
        # Start Async Loop in background thread
        self.loop = asyncio.new_event_loop()
        self.loop_thread = threading.Thread(target=self._run_loop, daemon=True)
        self.loop_thread.start()
        
        self.async_logic = AsyncAppLogic(self._log_from_async, self._update_row_from_async, self.cpu_executor)
        self.is_processing = False
        self.stop_requested = False
        self.run_future: Optional[CFuture] = None
        self.current_batch: list[PDFTask] = []
        self.start_btn: Optional[ttk.Button] = None
        self.stop_btn: Optional[ttk.Button] = None

        self._build_ui()
        self._poll_gui()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _submit_async(self, coro) -> CFuture:
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    async def _process_queue_async(self, tasks: list[PDFTask]):
        stopped = False
        try:
            for t in tasks:
                if self.stop_requested:
                    stopped = True
                    break
                self.gui_q.put(lambda task=t: self._log(f"➡️ Starting file: {task.path.name}"))
                await self.async_logic.process_task(t)
        except asyncio.CancelledError:
            stopped = True
            raise
        finally:
            if stopped:
                self.gui_q.put(lambda batch=tasks: self._mark_unfinished_as_stopped(batch))
            self.gui_q.put(lambda: setattr(self, "is_processing", False))
            self.gui_q.put(lambda: setattr(self, "run_future", None))
            self.gui_q.put(lambda: self._set_processing_ui(False))
            self.gui_q.put(lambda: self._log("⏹️ Queue stopped." if stopped else "✅ Queue finished."))

    # ───────────────── UI build ─────────────────
    def _build_ui(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=12, pady=8)
        
        btn_frm = ttk.Frame(top)
        btn_frm.pack(side="left")
        ttk.Button(btn_frm, text="Add PDFs…", command=self._add_pdfs).pack(side="left")
        ttk.Button(btn_frm, text="Remove", command=self._remove).pack(side="left", padx=6)
        
        # Options
        opt_frm = ttk.LabelFrame(top, text="Options")
        opt_frm.pack(side="left", padx=20, fill="y")
        
        self.parallel_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            opt_frm, 
            text="Parallel Mode", 
            variable=self.parallel_var
        ).pack(side="left", padx=8)

        # Model Selector
        ttk.Label(opt_frm, text="Model:").pack(side="left", padx=(10, 2))
        self.model_var = tk.StringVar(value=DEFAULT_MODEL_LABEL)
        ttk.Combobox(opt_frm, textvariable=self.model_var, values=MODEL_LABELS, width=62, state="readonly").pack(side="left")

        
        ttk.Label(opt_frm, text="| Max MB (0=inf):").pack(side="left")
        self.max_mb_var = tk.StringVar(value="0")
        ttk.Entry(opt_frm, textvariable=self.max_mb_var, width=6).pack(side="left", padx=4)

        action_row = ttk.Frame(self)
        action_row.pack(fill="x", padx=12, pady=(0, 5))
        self.start_btn = ttk.Button(action_row, text="Start Processing", command=self._start)
        self.start_btn.pack(side="left", fill="x", expand=True)
        self.stop_btn = ttk.Button(action_row, text="Stop", command=self._stop, state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))

        # Tree
        cols = ("file", "pages", "mode", "status", "progress")
        self.tree = ttk.Treeview(self, columns=cols, show="headings", height=10)
        self.tree.heading("file", text="PDF File")
        self.tree.column("file", width=350, anchor="w")
        self.tree.heading("pages", text="Pages")
        self.tree.column("pages", width=60, anchor="center")
        self.tree.heading("mode", text="Mode")
        self.tree.column("mode", width=80, anchor="center")
        self.tree.heading("status", text="Status")
        self.tree.column("status", width=160, anchor="center")
        self.tree.heading("progress", text="Progress")
        self.tree.column("progress", width=100, anchor="center")
        self.tree.pack(fill="x", padx=12, pady=(0, 5))

        log_frm = ttk.LabelFrame(self, text="Log")
        log_frm.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        self.log = tk.Text(log_frm, bg="#1e1e1e", fg="#d4d4d4", wrap="word", height=14)
        self.log.pack(fill="both", expand=True)
        self._log("🔍 Ready. 'Parallel Mode' is ON by default (super fast). Uncheck for sequential context-aware mode.")

    # ───────────────── Actions ─────────────────
    def _add_pdfs(self):
        files = filedialog.askopenfilenames(filetypes=[("PDF", "*.pdf")])
        for f in files:
            p = Path(f)
            if not any(t.path == p for t in self.tasks):
                t = PDFTask(p)
                self.tasks.append(t)
                self.tree.insert("", "end", iid=id(t), values=(p.name, "-", "-", t.status, "0%"))
                self._log(f"➕ Added {p.name}")

    def _remove(self):
        for iid in self.tree.selection():
            self.tree.delete(iid)
            self.tasks = [t for t in self.tasks if id(t) != int(iid)]
        self._log("🗑️ Removed selected items.")

    def _start(self):
        if not self.tasks:
            messagebox.showinfo("Info", "Queue is empty.")
            return
        if self.is_processing:
            messagebox.showinfo("Info", "Processing is already running.")
            return
        
        try:
            max_mb = float(self.max_mb_var.get().strip() or "0")
            if max_mb < 0: raise ValueError
        except ValueError:
            messagebox.showerror("Error", "Invalid Max MB")
            return
        
        max_bytes = int(max_mb * 1024 * 1024) if max_mb > 0 else None
        mode = "parallel" if self.parallel_var.get() else "sequential"
        selected_model = self.model_var.get()
        model = MODEL_ID_BY_LABEL.get(selected_model, selected_model)
        display_model = MODEL_LABEL_BY_ID.get(model, model)
        
        self._log(f"🚀 Starting conversion using {display_model} in {mode.upper()} mode…")
        
        queued_tasks: list[PDFTask] = []
        for t in self.tasks:
            # Accept queued, failed, or interrupted entries for restart.
            if t.status == "Done":
                continue
            if not (t.status == "Queued" or t.status == "Starting…" or t.status.startswith("Error")):
                continue

            if t.status.startswith("Error") or t.status == "Starting…":
                self._log(f"🔁 Re-queueing {t.path.name} (previous status: {t.status})")

            if t.status == "Queued" or t.status.startswith("Error") or t.status == "Starting…":
                t.status = "Starting…"
                t.max_bytes = max_bytes
                t.mode = mode
                t.model = model
                self._update_row(t)
                queued_tasks.append(t)
        
        if queued_tasks:
            self.is_processing = True
            self.stop_requested = False
            self.current_batch = queued_tasks
            self._set_processing_ui(True)
            self.run_future = self._submit_async(self._process_queue_async(queued_tasks))
        else:
            self._log("⚠️ No queued tasks found.")

    def _stop(self):
        if not self.is_processing:
            self._log("ℹ️ Nothing is running.")
            return
        self.stop_requested = True
        self._log("⏹️ Stop requested. Cancelling active processing…")
        if self.run_future and not self.run_future.done():
            self.run_future.cancel()

    def _mark_unfinished_as_stopped(self, tasks: list[PDFTask]):
        for t in tasks:
            if t.status == "Done" or t.status.startswith("Error"):
                continue
            t.status = "Stopped"
            self._update_row(t)

    def _set_processing_ui(self, running: bool):
        if self.start_btn:
            self.start_btn.config(state="disabled" if running else "normal")
        if self.stop_btn:
            self.stop_btn.config(state="normal" if running else "disabled")

    # ───────────────── GUI/Thread helpers ─────────────────
    def _update_row(self, task: PDFTask):
        pct = f"{task.progress * 100:.0f}%" if task.pages else "0%"
        if self.tree.exists(id(task)):
            self.tree.item(id(task), values=(task.path.name, task.pages or "-", task.mode, task.status, pct))

    def _update_row_from_async(self, task):
        self.gui_q.put(lambda: self._update_row(task))

    def _log(self, msg: str):
        self.log.config(state="normal")
        self.log.insert("end", msg + "\n")
        self.log.see("end")
        self.log.config(state="disabled")

    def _log_from_async(self, msg: str):
        self.gui_q.put(lambda: self._log(msg))

    def _poll_gui(self):
        while True:
            try:
                fn = self.gui_q.get_nowait()
                fn()
            except queue.Empty:
                break
        self.after(50, self._poll_gui)


if __name__ == "__main__":
    App().mainloop()
