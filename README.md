# SlideScribe

SlideScribe is an Electron desktop app for turning lecture PDFs into structured Markdown with Gemini vision models. It combines a desktop queue manager, a configurable system prompt, resumable processing, live logs, and a side-by-side PDF versus Markdown comparison view in one app.

The app keeps the conversion pipeline in Python and wraps it in a cleaner desktop workflow. Add one or more PDFs, choose a Gemini model, start a run, and SlideScribe writes the generated Markdown next to each source PDF.

## What The App Does

- Queues multiple PDFs for batch conversion
- Uses Gemini models only for page-by-page PDF-to-Markdown conversion
- Saves Markdown beside the original PDF as `<name>_llm_description.md`
- Stores resumable progress data in `pdf_converter_progress/`
- Lets you edit and reset the bundled system prompt
- Shows live activity logs during a run
- Includes a page comparison view for checking PDF output against generated Markdown

## Requirements

- Python 3.10 or newer
- Node.js 20 or newer
- A Gemini API key in `.env`

## Quick Start

After cloning the repo, run:

```bash
npm run setup
```

That setup command:

- creates a local `venv/`
- installs Python dependencies from `requirements.txt`
- installs Node dependencies with `npm install`
- creates `.env` from `.env.example` if it does not exist

Then open `.env` and set your Gemini key:

```env
GEMINI_API_KEY=...
# Optional
GEMINI_MODEL=gemini-2.5-flash
```

`GOOGLE_API_KEY` is also accepted as an alternative to `GEMINI_API_KEY`.

Start the app:

```bash
npm start
```

The Electron app will automatically use the repo-local virtual environment when it exists.

## Manual Setup

If you do not want to use the helper script, the equivalent steps are:

```bash
python3 -m venv venv
./venv/bin/python -m pip install --upgrade pip
./venv/bin/python -m pip install -r requirements.txt
npm install
cp .env.example .env
```

## Output

- Markdown output is written next to the source PDF
- Progress snapshots are written to `pdf_converter_progress/`
- Existing progress can be reused when the PDF filename stem matches

## Changes

- Removed OpenAI/GPT model options from the Electron app
- Switched app defaults and validation to Gemini-only models
- Updated backend key handling so the app requires a Gemini or Google API key
- Rewrote this README as a clean description of the desktop app

## Notes

- If Electron cannot find Python, set `PDF_CONVERTER_PYTHON=/absolute/path/to/python3`
- `npm run package` builds an unpacked Electron app
- `npm run dist` creates packaged artifacts with `electron-builder`
