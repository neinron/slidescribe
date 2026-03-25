const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const APP_NAME = "SlideScribe";
const APP_BUNDLE_ID = "com.jaronschurer.slidescribe";
const HELPER_BUNDLE_IDS = {
  helper: `${APP_BUNDLE_ID}.helper`,
  renderer: `${APP_BUNDLE_ID}.helper.renderer`,
  gpu: `${APP_BUNDLE_ID}.helper.gpu`,
  plugin: `${APP_BUNDLE_ID}.helper.plugin`,
  eh: `${APP_BUNDLE_ID}.helper.eh`,
};
const HELPER_APP_NAMES = [
  `${APP_NAME} Helper.app`,
  `${APP_NAME} Helper (Renderer).app`,
  `${APP_NAME} Helper (GPU).app`,
  `${APP_NAME} Helper (Plugin).app`,
  `${APP_NAME} Helper (EH).app`,
];
const NATIVE_BINARY_NAMES = ["chrome_crashpad_handler"];

function isMacOs() {
  return process.platform === "darwin";
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findPackagedApp(outputPaths) {
  const queue = Array.isArray(outputPaths) ? [...outputPaths] : [];

  while (queue.length > 0) {
    const currentPath = path.resolve(queue.shift());
    const stats = await fs.stat(currentPath);

    if (stats.isFile() && currentPath.endsWith(".app")) {
      return currentPath;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    if (currentPath.endsWith(".app")) {
      return currentPath;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const nextPath = path.join(currentPath, entry.name);
      if (entry.name.endsWith(".app")) {
        return nextPath;
      }
      queue.push(nextPath);
    }
  }

  throw new Error(`Could not find a packaged .app inside output paths: ${JSON.stringify(outputPaths)}`);
}

async function removeIfExists(targetPath) {
  if (await pathExists(targetPath)) {
    await fs.rm(targetPath, { recursive: true, force: true });
  }
}

async function moveApp(sourcePath, destinationPath) {
  await removeIfExists(destinationPath);

  try {
    await fs.rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
  }

  await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
  await fs.rm(sourcePath, { recursive: true, force: true });
}

async function collectSignTargets(appPath) {
  const signTargets = new Set();

  async function walk(currentPath) {
    const stats = await fs.lstat(currentPath);
    if (!stats.isDirectory()) {
      const extension = path.extname(currentPath);
      const basename = path.basename(currentPath);
      if ([".dylib", ".so", ".node"].includes(extension) || NATIVE_BINARY_NAMES.includes(basename)) {
        signTargets.add(currentPath);
      }
      return;
    }

    if (currentPath !== appPath && currentPath.endsWith(".app")) {
      signTargets.add(currentPath);
      return;
    }

    if (currentPath.endsWith(".framework")) {
      signTargets.add(currentPath);
      return;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      await walk(path.join(currentPath, entry.name));
    }
  }

  await walk(appPath);

  for (const helperName of HELPER_APP_NAMES) {
    const helperPath = path.join(appPath, "Contents", "Frameworks", helperName);
    if (await pathExists(helperPath)) {
      signTargets.add(helperPath);
    }
  }

  return Array.from(signTargets).sort((left, right) => left.length - right.length);
}

async function codesign(targetPath, bundleId) {
  const args = ["--force", "--sign", "-", "--timestamp=none"];
  if (bundleId) {
    args.push("--identifier", bundleId);
  }
  args.push(targetPath);
  await execFileAsync("/usr/bin/codesign", args);
}

async function signMovedAppIfNeeded(forgeConfig, appPath) {
  const shouldSign = Boolean(forgeConfig?.packagerConfig?.osxSign);
  if (!shouldSign) {
    return;
  }

  const signTargets = await collectSignTargets(appPath);
  for (const targetPath of signTargets) {
    const basename = path.basename(targetPath);
    if (basename === `${APP_NAME} Helper.app`) {
      await codesign(targetPath, HELPER_BUNDLE_IDS.helper);
      continue;
    }
    if (basename === `${APP_NAME} Helper (Renderer).app`) {
      await codesign(targetPath, HELPER_BUNDLE_IDS.renderer);
      continue;
    }
    if (basename === `${APP_NAME} Helper (GPU).app`) {
      await codesign(targetPath, HELPER_BUNDLE_IDS.gpu);
      continue;
    }
    if (basename === `${APP_NAME} Helper (Plugin).app`) {
      await codesign(targetPath, HELPER_BUNDLE_IDS.plugin);
      continue;
    }
    if (basename === `${APP_NAME} Helper (EH).app`) {
      await codesign(targetPath, HELPER_BUNDLE_IDS.eh);
      continue;
    }
    await codesign(targetPath);
  }

  await codesign(appPath, APP_BUNDLE_ID);
}

module.exports = async function postPackage(forgeConfig, options) {
  if (!isMacOs()) {
    return;
  }

  const packagedAppPath = await findPackagedApp(options?.outputPaths || []);
  const destinationPath = path.join("/Applications", `${APP_NAME}.app`);

  await moveApp(packagedAppPath, destinationPath);
  await signMovedAppIfNeeded(forgeConfig, destinationPath);

  console.log(`Moved packaged app to ${destinationPath}`);
};
