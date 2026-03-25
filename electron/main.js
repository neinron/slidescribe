const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MODEL_OPTIONS = [
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash ($0.30 in / $2.50 out per 1M)" },
  { id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite ($0.10 in / $0.40 out per 1M)" },
  { id: "gemini-2.5-pro", label: "gemini-2.5-pro ($1.25 in / $10.00 out per 1M)" },
  { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview ($1.50 in / $12.00 out per 1M, <=200k)" },
  { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview ($0.30 in / $2.50 out per 1M)" },
  { id: "gemini-3.1-flash-lite-preview", label: "gemini-3.1-flash-lite-preview ($0.10 in / $0.40 out per 1M)" },
  { id: "gemini-flash-latest", label: "gemini-flash-latest (alias, dynamic pricing)" }
];

const MODEL_IDS = new Set(MODEL_OPTIONS.map((option) => option.id));
const DEFAULT_MODEL = process.env.GEMINI_MODEL || process.env.OPENAI_MODEL || "gemini-2.5-flash";

const DEFAULT_SETTINGS = {
  mode: "parallel",
  model: DEFAULT_MODEL,
  maxMb: 0,
  systemPrompt: "",
  theme: "dark",
  promptCollapsed: false
};

let mainWindow = null;
let workerProcess = null;
let workerConfigPath = null;

function getAssetsDir() {
  return app.isPackaged ? path.join(app.getAppPath(), "assets") : path.join(__dirname, "..", "assets");
}

function getBackendDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(__dirname, "..", "backend");
}

function getDefaultPrompt() {
  return fs.readFileSync(path.join(getBackendDir(), "default_system_prompt.txt"), "utf8").trim();
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getSessionPath() {
  return path.join(app.getPath("userData"), "session.json");
}

function loadSettings() {
  const merged = { ...DEFAULT_SETTINGS, systemPrompt: getDefaultPrompt() };
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return merged;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const savedModel = typeof saved.model === "string" && MODEL_IDS.has(saved.model) ? saved.model : merged.model;
    return {
      ...merged,
      ...saved,
      model: savedModel,
      systemPrompt: typeof saved.systemPrompt === "string" && saved.systemPrompt.trim() ? saved.systemPrompt : merged.systemPrompt
    };
  } catch {
    return merged;
  }
}

function saveSettings(partialSettings) {
  const next = {
    ...loadSettings(),
    ...partialSettings
  };
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  return next;
}

function loadSession() {
  const sessionPath = getSessionPath();
  if (!fs.existsSync(sessionPath)) {
    return { queue: [], logs: [] };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    return {
      queue: Array.isArray(saved.queue) ? saved.queue : [],
      logs: Array.isArray(saved.logs) ? saved.logs : []
    };
  } catch {
    return { queue: [], logs: [] };
  }
}

function saveSession(session) {
  const next = {
    queue: Array.isArray(session?.queue) ? session.queue : [],
    logs: Array.isArray(session?.logs) ? session.logs : []
  };
  fs.mkdirSync(path.dirname(getSessionPath()), { recursive: true });
  fs.writeFileSync(getSessionPath(), JSON.stringify(next, null, 2));
  return next;
}

function resolvePythonExecutable() {
  const candidates = [
    process.env.PDF_CONVERTER_PYTHON,
    path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."), "venv", "bin", "python3"),
    path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."), "venv", "Scripts", "python.exe"),
    "python3",
    "python"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate.includes(path.sep) || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "python3";
}

function sendWorkerEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("worker:event", payload);
  }
}

function createMainWindow() {
  const iconPath = path.join(getAssetsDir(), "icon.png");
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#07111f",
    title: "SlideScribe",
    icon,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (process.platform === "darwin" && icon && !icon.isEmpty() && app.dock) {
    app.dock.setIcon(icon);
  }

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function cleanupWorkerArtifacts() {
  if (workerConfigPath && fs.existsSync(workerConfigPath)) {
    fs.rmSync(workerConfigPath, { force: true });
  }
  workerConfigPath = null;
}

function stopWorker() {
  if (!workerProcess) {
    return false;
  }
  workerProcess.kill("SIGTERM");
  return true;
}

async function startWorker(payload) {
  if (workerProcess) {
    throw new Error("A conversion run is already in progress.");
  }

  const settings = saveSettings(payload.settings || {});
  const config = {
    mode: settings.mode,
    model: MODEL_IDS.has(settings.model) ? settings.model : DEFAULT_SETTINGS.model,
    maxMb: Number(settings.maxMb || 0),
    systemPrompt: settings.systemPrompt,
    tasks: payload.tasks
  };

  const configDir = path.join(os.tmpdir(), "slidescribe");
  fs.mkdirSync(configDir, { recursive: true });
  workerConfigPath = path.join(configDir, `run-${Date.now()}.json`);
  fs.writeFileSync(workerConfigPath, JSON.stringify(config, null, 2));

  const pythonCmd = resolvePythonExecutable();
  const workerScript = path.join(getBackendDir(), "pdf_converter_worker.py");

  workerProcess = spawn(pythonCmd, [workerScript, "--config", workerConfigPath], {
    cwd: getBackendDir(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  workerProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        sendWorkerEvent(JSON.parse(trimmed));
      } catch {
        sendWorkerEvent({ type: "log", level: "warn", message: trimmed });
      }
    }
  });

  let stderrBuffer = "";
  workerProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        sendWorkerEvent({ type: "stderr", message: trimmed });
      }
    }
  });

  workerProcess.on("error", (error) => {
    sendWorkerEvent({ type: "fatal_error", message: error.message });
  });

  workerProcess.on("close", (code, signalCode) => {
    sendWorkerEvent({ type: "process_exit", code, signal: signalCode });
    workerProcess = null;
    cleanupWorkerArtifacts();
  });

  return { started: true };
}

app.whenReady().then(() => {
  createMainWindow();

  ipcMain.handle("dialog:select-pdfs", async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "PDF Documents", extensions: ["pdf"] }]
      });
      return result.canceled ? [] : result.filePaths;
    } catch (error) {
      throw new Error(`Failed to open file picker: ${error.message}`);
    }
  });

  ipcMain.handle("settings:load", async () => ({
    settings: loadSettings(),
    models: MODEL_OPTIONS,
    defaultPrompt: getDefaultPrompt(),
    session: loadSession()
  }));

  ipcMain.handle("settings:save", async (_event, partialSettings) => {
    return saveSettings(partialSettings);
  });

  ipcMain.handle("session:save", async (_event, session) => {
    return saveSession(session);
  });

  ipcMain.handle("compare:load", async (_event, pdfPath) => {
    const resolvedPdfPath = path.resolve(String(pdfPath));
    const markdownPath = path.join(
      path.dirname(resolvedPdfPath),
      `${path.basename(resolvedPdfPath, path.extname(resolvedPdfPath))}_llm_description.md`
    );

    const pdfBase64 = fs.readFileSync(resolvedPdfPath).toString("base64");
    const markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, "utf8") : "";

    return {
      pdfPath: resolvedPdfPath,
      markdownPath,
      markdown,
      pdfBase64
    };
  });

  ipcMain.handle("worker:start", async (_event, payload) => startWorker(payload));
  ipcMain.handle("worker:stop", async () => ({ stopped: stopWorker() }));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopWorker();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
