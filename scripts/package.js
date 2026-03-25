const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const STAGING_DIR = path.join(ROOT_DIR, ".packaging");
const STAGING_VENV_DIR = path.join(STAGING_DIR, "venv");
const TEMP_CONFIG_PATH = path.join(STAGING_DIR, "electron-builder.package.json");
const APP_NAME = "SlideScribe";
const APPLICATIONS_APP_PATH = path.join("/Applications", `${APP_NAME}.app`);

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function shouldSkip(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const name = path.basename(relativePath);
  return (
    name === ".DS_Store" ||
    normalized.includes("/__pycache__/") ||
    normalized.endsWith("/__pycache__") ||
    normalized.endsWith(".pyc")
  );
}

function copyDirDereferenced(sourceDir, targetDir, relativePath = "") {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const nextRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (shouldSkip(nextRelativePath)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const stats = fs.statSync(sourcePath);

    if (stats.isDirectory()) {
      copyDirDereferenced(sourcePath, targetPath, nextRelativePath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, stats.mode);
  }
}

function buildPackageConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const buildConfig = { ...(pkg.build || {}) };
  buildConfig.extraResources = (buildConfig.extraResources || []).map((entry) => {
    if (entry && entry.from === "venv") {
      return { ...entry, from: ".packaging/venv" };
    }
    return entry;
  });
  buildConfig.mac = { ...(buildConfig.mac || {}), identity: null };
  return buildConfig;
}

function findPackagedApp(rootPath) {
  const queue = [path.resolve(rootPath)];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    const stats = fs.statSync(currentPath);

    if (!stats.isDirectory()) {
      continue;
    }

    if (currentPath.endsWith(".app")) {
      return currentPath;
    }

    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      queue.push(path.join(currentPath, entry.name));
    }
  }

  throw new Error(`Could not find a packaged .app inside ${rootPath}`);
}

function moveAppReplacingOldVersion(sourcePath, destinationPath) {
  removeIfExists(destinationPath);

  try {
    fs.renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
  fs.rmSync(sourcePath, { recursive: true, force: true });
}

function main() {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  removeIfExists(STAGING_VENV_DIR);
  copyDirDereferenced(path.join(ROOT_DIR, "venv"), STAGING_VENV_DIR);

  const config = buildPackageConfig();
  fs.writeFileSync(TEMP_CONFIG_PATH, JSON.stringify(config, null, 2));

  const electronBuilderBin = path.join(ROOT_DIR, "node_modules", ".bin", "electron-builder");
  const child = spawn(electronBuilderBin, ["--dir", "--config", TEMP_CONFIG_PATH], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if ((code ?? 0) === 0) {
      const packagedAppPath = findPackagedApp(path.join(ROOT_DIR, "dist-electron"));
      moveAppReplacingOldVersion(packagedAppPath, APPLICATIONS_APP_PATH);
      console.log(`Moved packaged app to ${APPLICATIONS_APP_PATH}`);
    }
    process.exit(code ?? 0);
  });
}

main();
