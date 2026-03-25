import { pdfjsLib } from "./pdfjs-bootstrap.mjs";
import katex from "../../node_modules/katex/dist/katex.mjs";
import { marked } from "../../node_modules/marked/lib/marked.esm.js";

const state = {
  queue: [],
  processed: [],
  settings: null,
  defaultPrompt: "",
  isEditingApiKey: false,
  isRunning: false,
  compareOpen: false,
  logs: []
};

const elements = {
  addPdfs: document.getElementById("add-pdfs"),
  clearQueue: document.getElementById("clear-queue"),
  startRun: document.getElementById("start-run"),
  stopRun: document.getElementById("stop-run"),
  modeSelect: document.getElementById("mode-select"),
  modelSelect: document.getElementById("model-select"),
  maxMb: document.getElementById("max-mb"),
  apiKey: document.getElementById("api-key"),
  editApiKey: document.getElementById("edit-api-key"),
  systemPrompt: document.getElementById("system-prompt"),
  resetPrompt: document.getElementById("reset-prompt"),
  togglePrompt: document.getElementById("toggle-prompt"),
  promptCard: document.getElementById("prompt-card"),
  promptBody: document.querySelector("#prompt-card .prompt-body"),
  queueBody: document.getElementById("queue-body"),
  processedBody: document.getElementById("processed-body"),
  queueCount: document.getElementById("queue-count"),
  runState: document.getElementById("run-state"),
  logOutput: document.getElementById("log-output"),
  copyLogs: document.getElementById("copy-logs"),
  clearLog: document.getElementById("clear-log"),
  themeToggle: document.getElementById("theme-toggle"),
  compareModal: document.getElementById("compare-modal"),
  closeCompare: document.getElementById("close-compare"),
  compareStatus: document.getElementById("compare-status"),
  compareContent: document.getElementById("compare-content"),
  compareSubtitle: document.getElementById("compare-subtitle")
};

let saveTimer = null;
let sessionSaveTimer = null;
let removeWorkerListener = null;

function createTask(pathname) {
  const parts = pathname.split(/[\\/]/);
  const name = parts[parts.length - 1];
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    path: pathname,
    name,
    mode: "",
    status: "Queued",
    pages: 0,
    done: 0,
    progress: 0
  };
}

function sanitizeTask(rawTask) {
  if (!rawTask || typeof rawTask.path !== "string" || !rawTask.path.trim()) {
    return null;
  }

  const task = createTask(rawTask.path);
  return {
    ...task,
    id: typeof rawTask.id === "string" && rawTask.id.trim() ? rawTask.id : task.id,
    name: typeof rawTask.name === "string" && rawTask.name.trim() ? rawTask.name : task.name,
    mode: typeof rawTask.mode === "string" ? rawTask.mode : "",
    status: typeof rawTask.status === "string" ? rawTask.status : "Queued",
    pages: Number.isFinite(rawTask.pages) ? rawTask.pages : 0,
    done: Number.isFinite(rawTask.done) ? rawTask.done : 0,
    progress: Number.isFinite(rawTask.progress) ? rawTask.progress : 0
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMathSegment(content, isBlock, rawMatch) {
  try {
    return katex.renderToString(content, {
      displayMode: isBlock,
      throwOnError: true,
      strict: "ignore"
    });
  } catch {
    return `<span class="math-fallback">${escapeHtml(rawMatch)}</span>`;
  }
}

marked.use({
  breaks: true,
  gfm: true,
  extensions: [
    {
      name: "blockMath",
      level: "block",
      start(src) {
        const match = src.match(/(?:\$\$|\\\[|\\\$\$)/);
        return match ? match.index : undefined;
      },
      tokenizer(src) {
        const match = src.match(/^(\\\$\$[\s\S]+?\\\$\$|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])/);
        if (!match) {
          return undefined;
        }
        const raw = match[0];
        const unescapedRaw = raw
          .replace(/^\\\$\$/g, "$$")
          .replace(/\\\$\$$/g, "$$");
        const text = unescapedRaw
          .replace(/^\$\$|^\s*\\\[|\$\$$|\s*\\\]$/g, "")
          .trim();
        return {
          type: "blockMath",
          raw,
          text,
          rawMath: unescapedRaw
        };
      },
      renderer(token) {
        return renderMathSegment(token.text, true, token.rawMath);
      }
    },
    {
      name: "inlineMath",
      level: "inline",
      start(src) {
        const match = src.match(/(?:\$|\\\(|\\\$)/);
        return match ? match.index : undefined;
      },
      tokenizer(src) {
        const match = src.match(/^(\\\$[^$\n]+?\\\$|\$[^$\n]+?\$|\\\([^$\n]*?\\\))/);
        if (!match) {
          return undefined;
        }
        const raw = match[0];
        const unescapedRaw = raw
          .replace(/^\\\$/g, "$")
          .replace(/\\\$$/g, "$");
        const text = unescapedRaw
          .replace(/^\$|\$$/g, "")
          .replace(/^\\\(|\\\)$/g, "")
          .trim();
        return {
          type: "inlineMath",
          raw,
          text,
          rawMath: unescapedRaw
        };
      },
      renderer(token) {
        return renderMathSegment(token.text, false, token.rawMath);
      }
    }
  ]
});

function normalizeMatrixLatex(source) {
  return source.replace(
    /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g,
    (_match, envName, matrixContent) => {
      const fixedContent = matrixContent
        .replace(/\r\n/g, "\n")
        .replace(/(?<!\\)\\(?=\s*(?:\n|$))/g, "\\\\")
        .replace(/\n{3,}/g, "\n\n");

      return `\\begin{${envName}}${fixedContent}\\end{${envName}}`;
    }
  );
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function looksLikeTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function protectMalformedTables(source) {
  const lines = (source || "").split(/\r?\n/);
  const protectedRanges = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableSeparator(lines[index])) {
      continue;
    }

    let start = index - 1;
    while (start >= 0 && lines[start].trim()) {
      start -= 1;
    }
    start += 1;

    let end = index + 1;
    while (end < lines.length && lines[end].trim()) {
      end += 1;
    }

    const blockLines = lines.slice(start, end);
    const malformed = blockLines.some((line, blockIndex) => {
      if (!line.trim()) {
        return false;
      }
      if (start + blockIndex === index) {
        return false;
      }
      return !looksLikeTableRow(line);
    });

    if (malformed) {
      protectedRanges.push({ start, end });
      index = end - 1;
    }
  }

  if (!protectedRanges.length) {
    return source || "";
  }

  const chunks = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    if (range.start > cursor) {
      chunks.push(lines.slice(cursor, range.start).join("\n"));
    }
    chunks.push(`<pre class="markdown-card-fallback">${escapeHtml(lines.slice(range.start, range.end).join("\n"))}</pre>`);
    cursor = range.end;
  }
  if (cursor < lines.length) {
    chunks.push(lines.slice(cursor).join("\n"));
  }

  return chunks.join("\n\n");
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${message}`;
  state.logs.push(line);
  elements.logOutput.textContent = state.logs.join("\n");
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  scheduleSessionSave();
}

function updateRunState(label, tone = "idle") {
  elements.runState.textContent = label;
}

function scheduleSettingsSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(async () => {
    await flushSettingsSave();
  }, 250);
}

async function flushSettingsSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!state.settings) {
    return;
  }
  state.settings = collectSettings();
  await window.slidescribe.saveSettings(state.settings);
}

function scheduleSessionSave() {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
  }
  sessionSaveTimer = setTimeout(async () => {
    await window.slidescribe.saveSession({
      queue: state.queue,
      processed: state.processed,
      logs: state.logs
    });
  }, 250);
}

function collectSettings() {
  return {
    mode: elements.modeSelect.value,
    model: elements.modelSelect.value,
    maxMb: Number(elements.maxMb.value || 0),
    geminiApiKey: elements.apiKey.value.trim(),
    systemPrompt: elements.systemPrompt.value,
    theme: document.body.dataset.theme || "dark",
    promptCollapsed: elements.promptCard.dataset.collapsed === "true"
  };
}

function setApiKeyEditing(isEditing) {
  state.isEditingApiKey = isEditing;
  elements.apiKey.readOnly = !isEditing;
  elements.apiKey.type = isEditing ? "text" : "password";
  elements.editApiKey.textContent = isEditing ? "Done" : "Edit";
  if (isEditing) {
    elements.apiKey.focus();
    elements.apiKey.setSelectionRange(elements.apiKey.value.length, elements.apiKey.value.length);
  } else {
    elements.apiKey.blur();
  }
}

function isTaskActive(task) {
  return task.status === "Preparing" || task.status === "Running";
}

function resetTaskForProcessing(task) {
  task.mode = state.settings?.mode || "";
  task.status = "Queued";
  task.pages = 0;
  task.done = 0;
  task.progress = 0;
}

async function startTasks(tasks, label) {
  if (!tasks.length || state.isRunning) {
    return;
  }

  state.settings = collectSettings();
  if (!state.settings.systemPrompt.trim()) {
    appendLog("System prompt cannot be empty.");
    return;
  }

  for (const task of tasks) {
    resetTaskForProcessing(task);
  }

  renderQueue();
  updateRunState("Launching");
  appendLog(`${label} with model ${state.settings.model}.`);

  try {
    await window.slidescribe.startWorker({
      settings: state.settings,
      tasks: tasks.map((task) => ({ id: task.id, path: task.path }))
    });
  } catch (error) {
    state.isRunning = false;
    updateRunState("Error");
    appendLog(`Start failed: ${error.message}`);
    renderQueue();
  }
}

async function processSingleTask(task, fromProcessed = false) {
  if (state.isRunning) {
    return;
  }

  let targetTask = task;
  if (fromProcessed) {
    const existingQueuedTask = state.queue.find((entry) => entry.path === task.path);
    if (existingQueuedTask) {
      targetTask = existingQueuedTask;
    } else {
      targetTask = createTask(task.path);
      targetTask.name = task.name;
      state.queue.push(targetTask);
      state.processed = state.processed.filter((entry) => entry.id !== task.id);
    }
  }

  await startTasks([targetTask], `Launching ${targetTask.name}`);
}

async function stopSingleTask(task) {
  if (!state.isRunning || !isTaskActive(task)) {
    return;
  }
  await window.slidescribe.stopWorker();
  appendLog(`Stop requested for ${task.name}.`);
}

function renderTaskList(tasks, container, options = {}) {
  const isProcessedList = Boolean(options.processed);
  container.innerHTML = "";
  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        ${isProcessedList
          ? "Processed files will appear here after conversion finishes."
          : "Add one or more PDFs to start a run. Finished files can be compared page by page against their generated Markdown here."}
      </div>
    `;
  }

  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = "queue-item";

    const main = document.createElement("div");
    main.className = "queue-main";
    const percent = Math.max(0, Math.min(100, Math.round(task.progress * 100)));
    const statusLabel = task.status === "Done" ? "Processed" : task.status || "Queued";
    const metaItems = [task.mode || "—", statusLabel];
    if (task.pages) {
      metaItems.push(`${task.done}/${task.pages} pages`);
    }
    if (task.status !== "Done") {
      metaItems.push(`${percent}%`);
    }
    const processButtonLabel = isProcessedList ? "Reprocess file" : "Process file";
    const pathId = `task-path-${task.id}`;
    main.innerHTML = `
      <div class="queue-file-header">
        <div class="queue-file-summary">
          <div class="file-name">${escapeHtml(task.name)}</div>
          <div class="queue-meta">
            ${metaItems
              .map((item, index) => `<span class="meta-chip${index === 1 ? " status-chip" : ""}">${escapeHtml(item)}</span>`)
              .join('<span class="meta-separator">•</span>')}
          </div>
        </div>
      </div>
    `;

    if (task.status !== "Done") {
      const progressCell = document.createElement("div");
      progressCell.className = "queue-progress-wrap";
      const progressBar = document.createElement("div");
      progressBar.className = "progress-bar";
      const progressInner = document.createElement("span");
      progressInner.style.width = `${percent}%`;
      progressBar.appendChild(progressInner);
      progressCell.appendChild(progressBar);
      main.appendChild(progressCell);
    }

    const actions = document.createElement("div");
    actions.className = "queue-actions";
    const processButton = document.createElement("button");
    processButton.type = "button";
    processButton.className = "ghost inline-action";
    processButton.textContent = isTaskActive(task) ? "Running" : "Process";
    processButton.disabled = state.isRunning || isTaskActive(task);
    processButton.title = processButtonLabel;
    processButton.addEventListener("click", async () => {
      await processSingleTask(task, isProcessedList);
    });

    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "ghost inline-action";
    stopButton.textContent = "Stop";
    stopButton.disabled = !isTaskActive(task);
    stopButton.title = "Stop file";
    stopButton.addEventListener("click", async () => {
      await stopSingleTask(task);
    });

    const pathToggle = createIconButton(
      "Show file path",
      `
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h6l2 2h8v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"></path>
        </svg>
      `
    );
    pathToggle.setAttribute("aria-expanded", "false");
    pathToggle.setAttribute("aria-controls", pathId);

    const clearCacheButton = createIconButton(
      "Clear generated Markdown and cached progress",
      `
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v4"></path>
          <path d="M7 5h10"></path>
          <path d="M5 9h14"></path>
          <path d="M6 9l1 10h10l1-10"></path>
          <path d="M10 13h4"></path>
        </svg>
      `
    );
    clearCacheButton.disabled = state.isRunning && !isProcessedList;
    clearCacheButton.addEventListener("click", async () => {
      await clearTaskCache(task);
    });

    const copyButton = createIconButton(
      "Copy generated Markdown",
      `
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="10" height="10" rx="2"></rect>
          <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>
        </svg>
      `
    );
    copyButton.disabled = task.status !== "Done";
    copyButton.addEventListener("click", async () => {
      await copyTaskMarkdown(task, copyButton);
    });

    const compareButton = createIconButton(
      "Compare PDF and Markdown",
      `
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5h8v14H3z"></path>
          <path d="M13 5h8v14h-8z"></path>
          <path d="M11 7h2"></path>
          <path d="M11 12h2"></path>
          <path d="M11 17h2"></path>
        </svg>
      `
    );
    compareButton.disabled = task.status !== "Done";
    compareButton.addEventListener("click", () => openCompareModal(task));

    const deleteButton = createIconButton(
      isProcessedList ? "Remove file from processed list" : "Delete file from queue",
      `
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v5"></path>
          <path d="M14 11v5"></path>
        </svg>
      `,
      "danger"
    );
    deleteButton.disabled = !isProcessedList && isTaskActive(task);
    deleteButton.addEventListener("click", () => removeTask(task.id, isProcessedList));

    actions.append(processButton, stopButton, pathToggle, clearCacheButton, copyButton, compareButton, deleteButton);
    main.querySelector(".queue-file-header").appendChild(actions);

    card.append(main);

    const pathRow = document.createElement("div");
    pathRow.className = "queue-file-path-row";
    pathRow.innerHTML = `
      <a id="${pathId}" class="file-path hidden" href="#" title="Show in Finder">${escapeHtml(task.path)}</a>
    `;
    const pathLink = pathRow.querySelector(".file-path");
    pathToggle.addEventListener("click", () => {
      const expanded = pathToggle.getAttribute("aria-expanded") === "true";
      pathToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      pathToggle.title = expanded ? "Show file path" : "Hide file path";
      pathLink.classList.toggle("hidden", expanded);
    });
    pathLink.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await window.slidescribe.showInFinder(task.path);
      } catch (error) {
        appendLog(`Failed to show ${task.name} in Finder: ${error.message}`);
      }
    });

    main.appendChild(pathRow);
    container.appendChild(card);
  }
}

function renderQueue() {
  renderTaskList(state.queue, elements.queueBody);
  renderTaskList(state.processed, elements.processedBody, { processed: true });
  elements.queueCount.textContent = `${state.queue.length} PDF${state.queue.length === 1 ? "" : "s"}`;
  elements.clearQueue.disabled = state.queue.length === 0 || state.isRunning;
  elements.startRun.disabled = state.isRunning || state.queue.length === 0;
  elements.stopRun.disabled = !state.isRunning;
}

function createIconButton(label, svg, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${extraClass}`.trim();
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = svg;
  return button;
}

function flashSuccessIcon(button, label) {
  if (!button) {
    return;
  }

  const originalMarkup = button.innerHTML;
  const originalLabel = button.getAttribute("aria-label") || label;
  const originalTitle = button.title || label;

  if (button._successFlashTimer) {
    clearTimeout(button._successFlashTimer);
  }

  button.setAttribute("aria-label", `${label} copied`);
  button.title = `${label} copied`;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12.5l4.2 4.2L19 7"></path>
    </svg>
  `;

  button._successFlashTimer = setTimeout(() => {
    button.innerHTML = originalMarkup;
    button.setAttribute("aria-label", originalLabel);
    button.title = originalTitle;
    button._successFlashTimer = null;
  }, 1200);
}

function removeTask(taskId, fromProcessed = false) {
  if (fromProcessed) {
    state.processed = state.processed.filter((task) => task.id !== taskId);
  } else {
    state.queue = state.queue.filter((task) => task.id !== taskId);
  }
  renderQueue();
  scheduleSessionSave();
}

function removeCompletedTask(taskId) {
  const task = state.queue.find((entry) => entry.id === taskId);
  if (task) {
    state.processed.unshift({ ...task, status: "Done", progress: 1 });
  }
  state.queue = state.queue.filter((task) => task.id !== taskId);
  renderQueue();
  scheduleSessionSave();
}

function updateTask(taskId, patch) {
  const task = state.queue.find((entry) => entry.id === taskId);
  if (!task) {
    return;
  }
  Object.assign(task, patch);
  renderQueue();
  scheduleSessionSave();
}

function attachWorkerEvents() {
  removeWorkerListener = window.slidescribe.onWorkerEvent((event) => {
    switch (event.type) {
      case "run_started":
        state.isRunning = true;
        updateRunState("Running");
        appendLog(`Started conversion for ${event.taskCount} file(s).`);
        renderQueue();
        break;
      case "task_update":
        if (event.status === "Done") {
          appendLog(`${lookupTaskName(event.taskId)} processed and removed from the queue.`);
          removeCompletedTask(event.taskId);
          break;
        }
        updateTask(event.taskId, {
          status: event.status || "Running",
          pages: event.pages || 0,
          done: event.done || 0,
          progress: typeof event.progress === "number" ? event.progress : 0
        });
        if (event.error) {
          appendLog(`Error for ${event.taskId}: ${event.error}`);
        }
        break;
      case "page_done":
        appendLog(`Processed page ${event.page}/${event.pages} for ${lookupTaskName(event.taskId)}.`);
        break;
      case "log":
        appendLog(event.message);
        break;
      case "stderr":
        appendLog(`stderr: ${event.message}`);
        break;
      case "fatal_error":
        state.isRunning = false;
        updateRunState("Error");
        appendLog(`Fatal error: ${event.message}`);
        renderQueue();
        break;
      case "run_finished":
        state.isRunning = false;
        updateRunState(event.status === "completed" ? "Idle" : "Stopped");
        appendLog(`Run finished with status: ${event.status}.`);
        renderQueue();
        break;
      case "process_exit":
        state.isRunning = false;
        if (event.code && event.code !== 0) {
          updateRunState("Error");
          appendLog(`Worker exited with code ${event.code}.`);
        }
        renderQueue();
        break;
      default:
        appendLog(JSON.stringify(event));
    }
  });
}

function lookupTaskName(taskId) {
  return state.queue.find((task) => task.id === taskId)?.name || state.processed.find((task) => task.id === taskId)?.name || taskId;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  elements.themeToggle.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
}

function setPromptCollapsed(collapsed) {
  elements.promptCard.dataset.collapsed = collapsed ? "true" : "false";
  if (elements.promptBody) {
    elements.promptBody.hidden = collapsed;
  }
  elements.togglePrompt.textContent = collapsed ? "Show Prompt" : "Hide Prompt";
  elements.togglePrompt.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (!collapsed) {
    requestAnimationFrame(() => autoGrowTextarea(elements.systemPrompt));
  }
}

function autoGrowTextarea(textarea) {
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(136, textarea.scrollHeight)}px`;
}

function splitMarkdownByPage(markdownText) {
  const normalized = (markdownText || "").trim();
  if (!normalized) {
    return [];
  }

  const parts = normalized.split(/(?=^## Page \d+\s*$)/gm).filter(Boolean);
  return parts.map((part, index) => {
    const match = part.match(/^## Page (\d+)/m);
    return {
      pageNumber: match ? Number(match[1]) : index + 1,
      markdown: part.trim()
    };
  });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function renderMarkdown(markdown) {
  try {
    const prepared = protectMalformedTables(normalizeMatrixLatex(markdown || ""));
    return marked.parse(prepared, { async: false });
  } catch {
    return `<pre class="markdown-card-fallback">${escapeHtml(markdown || "")}</pre>`;
  }
}

async function openCompareModal(task) {
  state.compareOpen = true;
  elements.compareModal.classList.remove("hidden");
  elements.compareModal.setAttribute("aria-hidden", "false");
  elements.compareSubtitle.textContent = task.name;
  elements.compareStatus.textContent = "Loading PDF pages and Markdown output…";
  elements.compareContent.innerHTML = "";

  try {
    const compareData = await window.slidescribe.loadCompareData(task.path);
    const markdownPages = splitMarkdownByPage(compareData.markdown);
    const pdfData = base64ToUint8Array(compareData.pdfBase64);
    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;

    elements.compareStatus.textContent = compareData.markdown
      ? `Showing ${pdf.numPages} PDF page(s) against ${markdownPages.length} Markdown section(s).`
      : "No Markdown file found yet. Showing PDF pages with empty Markdown panels.";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas rendering context is unavailable.");
      }
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: context, viewport }).promise;

      const pageMarkdown = markdownPages.find((entry) => entry.pageNumber === pageNumber)?.markdown || "No Markdown found for this page yet.";
      const pair = document.createElement("section");
      pair.className = "compare-pair";
      pair.innerHTML = `
        <div class="compare-pane">
          <div class="compare-pane-head">PDF Page ${pageNumber}</div>
          <div class="compare-pane-body compare-pdf-body"></div>
        </div>
        <div class="compare-pane">
          <div class="compare-pane-head">Markdown Page ${pageNumber}</div>
          <div class="compare-pane-body">
            <div class="markdown-card">${renderMarkdown(pageMarkdown)}</div>
          </div>
        </div>
      `;
      pair.querySelector(".compare-pdf-body").appendChild(canvas);
      elements.compareContent.appendChild(pair);
    }
  } catch (error) {
    elements.compareStatus.textContent = `Failed to load comparison view: ${error.message}`;
    appendLog(`Compare failed for ${task.name}: ${error.message}`);
  }
}

async function copyTaskMarkdown(task, button = null) {
  try {
    const compareData = await window.slidescribe.loadCompareData(task.path);
    const markdown = compareData.markdown || "";
    if (!markdown.trim()) {
      appendLog(`No Markdown output found for ${task.name}.`);
      return;
    }
    await navigator.clipboard.writeText(markdown);
    flashSuccessIcon(button, "Copy generated Markdown");
    appendLog(`Copied Markdown for ${task.name}.`);
  } catch (error) {
    appendLog(`Failed to copy Markdown for ${task.name}: ${error.message}`);
  }
}

async function clearTaskCache(task) {
  const confirmed = window.confirm(`Clear generated Markdown and cached progress for "${task.name}"?`);
  if (!confirmed) {
    return;
  }

  try {
    await window.slidescribe.clearCache(task.path);
    const queuedTask = state.queue.find((entry) => entry.id === task.id);
    if (queuedTask) {
      updateTask(task.id, {
        status: "Queued",
        pages: 0,
        done: 0,
        progress: 0
      });
    } else {
      state.processed = state.processed.filter((entry) => entry.id !== task.id);
      const resetTask = createTask(task.path);
      resetTask.name = task.name;
      state.queue.push(resetTask);
      renderQueue();
      scheduleSessionSave();
    }
    appendLog(`Cleared cached Markdown and progress for ${task.name}.`);
  } catch (error) {
    appendLog(`Failed to clear cache for ${task.name}: ${error.message}`);
  }
}

function closeCompareModal() {
  state.compareOpen = false;
  elements.compareModal.classList.add("hidden");
  elements.compareModal.setAttribute("aria-hidden", "true");
  elements.compareContent.innerHTML = "";
  elements.compareStatus.textContent = "";
}

async function initialize() {
  const payload = await window.slidescribe.loadSettings();
  state.settings = payload.settings;
  state.defaultPrompt = payload.defaultPrompt;
  state.queue = Array.isArray(payload.session?.queue)
    ? payload.session.queue.map(sanitizeTask).filter(Boolean)
    : [];
  state.processed = Array.isArray(payload.session?.processed)
    ? payload.session.processed.map(sanitizeTask).filter(Boolean)
    : [];
  state.logs = Array.isArray(payload.session?.logs) ? payload.session.logs : [];

  for (const option of payload.models) {
    const node = document.createElement("option");
    node.value = option.id;
    node.textContent = option.label;
    elements.modelSelect.appendChild(node);
  }

  elements.modeSelect.value = state.settings.mode;
  elements.modelSelect.value = state.settings.model;
  elements.maxMb.value = state.settings.maxMb;
  elements.apiKey.value = state.settings.geminiApiKey || "";
  elements.systemPrompt.value = state.settings.systemPrompt;
  setPromptCollapsed(Boolean(state.settings.promptCollapsed));
  setApiKeyEditing(false);
  applyTheme(state.settings.theme || "dark");
  autoGrowTextarea(elements.systemPrompt);
  elements.logOutput.textContent = state.logs.join("\n");

  attachWorkerEvents();
  renderQueue();
}

function addFilesToQueue(filePaths) {
  const knownPaths = new Set(state.queue.map((task) => task.path));
  for (const filePath of filePaths) {
    if (!knownPaths.has(filePath)) {
      state.queue.push(createTask(filePath));
      appendLog(`Added ${filePath}`);
    }
  }
  renderQueue();
  scheduleSessionSave();
}

elements.addPdfs.addEventListener("click", async () => {
  try {
    const filePaths = await window.slidescribe.selectPdfs();
    addFilesToQueue(filePaths);
  } catch (error) {
    appendLog(`File picker failed: ${error.message}`);
  }
});

/* retained utility for future drag/drop support */
function handleSelectedPaths(filePaths) {
  if (Array.isArray(filePaths) && filePaths.length > 0) {
    addFilesToQueue(filePaths);
  }
}

elements.clearQueue.addEventListener("click", () => {
  state.queue = [];
  renderQueue();
  scheduleSessionSave();
});

elements.startRun.addEventListener("click", async () => {
  await startTasks(state.queue, `Launching ${state.queue.length} file(s)`);
});

elements.stopRun.addEventListener("click", async () => {
  await window.slidescribe.stopWorker();
  appendLog("Stop requested.");
});

elements.resetPrompt.addEventListener("click", async () => {
  elements.systemPrompt.value = state.defaultPrompt;
  autoGrowTextarea(elements.systemPrompt);
  scheduleSettingsSave();
});

elements.editApiKey.addEventListener("click", async () => {
  if (state.isEditingApiKey) {
    setApiKeyEditing(false);
    await flushSettingsSave();
    appendLog("Saved Gemini API key.");
    return;
  }
  setApiKeyEditing(true);
});

elements.togglePrompt.addEventListener("click", () => {
  const nextCollapsed = elements.promptCard.dataset.collapsed !== "true";
  setPromptCollapsed(nextCollapsed);
  scheduleSettingsSave();
});

elements.clearLog.addEventListener("click", () => {
  state.logs = [];
  elements.logOutput.textContent = "";
  scheduleSessionSave();
});

elements.copyLogs.addEventListener("click", async () => {
  const text = elements.logOutput.textContent || "";
  if (!text.trim()) {
    appendLog("No logs to copy.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    appendLog("Copied all logs to clipboard.");
  } catch (error) {
    appendLog(`Failed to copy logs: ${error.message}`);
  }
});

elements.themeToggle.addEventListener("click", async () => {
  const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  scheduleSettingsSave();
});

elements.closeCompare.addEventListener("click", closeCompareModal);
elements.compareModal.addEventListener("click", (event) => {
  if (event.target === elements.compareModal) {
    closeCompareModal();
  }
});

elements.systemPrompt.addEventListener("input", () => {
  autoGrowTextarea(elements.systemPrompt);
  scheduleSettingsSave();
});

elements.apiKey.addEventListener("input", scheduleSettingsSave);
elements.apiKey.addEventListener("blur", async () => {
  if (!state.isEditingApiKey) {
    return;
  }
  setApiKeyEditing(false);
  await flushSettingsSave();
});

for (const element of [elements.modeSelect, elements.modelSelect, elements.maxMb]) {
  element.addEventListener("input", scheduleSettingsSave);
  element.addEventListener("change", scheduleSettingsSave);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.compareOpen) {
    closeCompareModal();
  }
});

window.addEventListener("beforeunload", () => {
  if (removeWorkerListener) {
    removeWorkerListener();
  }
  void flushSettingsSave();
});

initialize();
