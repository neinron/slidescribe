const path = require("path");

const APP_NAME = "SlideScribe";
const APP_BUNDLE_ID = "com.jaronschurer.slidescribe";

const extraResources = [
  path.resolve(__dirname, "backend"),
  path.resolve(__dirname, "venv"),
];

const ignorePatterns = [
  /^\/\.git/,
  /^\/\.vscode/,
  /^\/dist-electron/,
  /^\/dist-forge/,
  /^\/venv/,
  /^\/pdf_converter_progress/,
  /^\/preview_page.*\.jpg$/,
  /^\/__pycache__/,
  /^\/backend\/__pycache__/,
  /^\/\.DS_Store$/,
  /^\/electron\/\.DS_Store$/,
];

module.exports = {
  packagerConfig: {
    name: APP_NAME,
    executableName: APP_NAME,
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.productivity",
    icon: path.resolve(__dirname, "assets", "icon"),
    out: path.resolve(__dirname, "dist-forge"),
    osxSign: process.platform === "darwin" ? {} : undefined,
    extraResource: extraResources,
    ignore: ignorePatterns,
  },
  hooks: {
    postPackage: async (forgeConfig, options) => {
      const postPackage = require("./scripts/post-package");
      await postPackage(forgeConfig, options);
    },
  },
};
