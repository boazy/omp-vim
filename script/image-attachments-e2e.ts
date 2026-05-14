import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import installPiVim from "../index.js";
import {
  createExtensionApiHarness,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "../test/harness.js";

type RuntimeEditorFactory = (
  tui: typeof stubTui,
  theme: typeof stubTheme,
  keybindings: typeof stubKeybindings,
) => unknown;

type WidgetCall = {
  key: string;
  content: string[] | undefined;
  options: { placement?: string } | undefined;
};

type NotificationCall = {
  message: string;
  type: string;
};

type SentUserMessage = {
  content: unknown;
  options: unknown;
};

type RuntimeContext = {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  ui: {
    theme: typeof stubTheme;
    setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void;
    setEditorComponent(factory: RuntimeEditorFactory | undefined): void;
    getEditorComponent(): RuntimeEditorFactory | undefined;
    notify(message: string, type: string): void;
  };
  shutdown(): void;
};

type RuntimeHarness = {
  ctx: RuntimeContext;
  widgetCalls: WidgetCall[];
  notifications: NotificationCall[];
  getEditorFactory(): RuntimeEditorFactory;
};

type EditorSurface = {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  addToHistory(text: string): void;
  insertTextAtCursor(text: string): void;
  getExpandedText(): string;
  setAutocompleteProvider(provider: unknown): void;
  setPaddingX(padding: number): void;
  setAutocompleteMaxVisible(maxVisible: number): void;
  onAction(action: string): void;
  getLines(): string[];
  getCursor(): { line: number; col: number };
  getMode(): string;
};

type PiExtension = (pi: unknown) => void;

const IMAGE_PACKAGE_NAME = "@jordyvd/pi-image-attachments";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const WRAPPABLE_BASELINE_METHODS = [
  "render",
  "invalidate",
  "handleInput",
  "getText",
  "setText",
  "addToHistory",
  "insertTextAtCursor",
  "getExpandedText",
  "setAutocompleteProvider",
  "setPaddingX",
  "setAutocompleteMaxVisible",
  "onAction",
  "getLines",
  "getCursor",
  "getMode",
] as const;
const WRAPPABLE_BASELINE_FIELDS = [
  "onSubmit",
  "onChange",
  "borderColor",
  "focused",
  "disableSubmit",
  "actionHandlers",
  "onEscape",
  "onCtrlD",
  "onPasteImage",
  "onExtensionShortcut",
] as const;

const currentRequire = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.name === "string") return parsed.name;
  } catch {
    return null;
  }
  return null;
}

function findPackageRoot(specifier: string): string {
  const nodeModulesCandidate = join(projectRoot, "node_modules", ...specifier.split("/"));
  if (hasPackageName(nodeModulesCandidate, specifier)) {
    return nodeModulesCandidate;
  }

  try {
    let dir = dirname(currentRequire.resolve(specifier));

    while (true) {
      const packageJsonPath = join(dir, "package.json");
      if (existsSync(packageJsonPath) && readPackageName(packageJsonPath) === specifier) {
        return dir;
      }

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the infrastructure error below.
  }

  throw new Error(`FAIL-INFRA: unable to locate installed package root for ${specifier}`);
}

function hasPackageName(packageDir: string, expectedName: string): boolean {
  const packageJsonPath = join(packageDir, "package.json");
  return existsSync(packageJsonPath) && readPackageName(packageJsonPath) === expectedName;
}

function packLocalImageAttachments(packageDir: string, workspace: string): string {
  try {
    const output = execFileSync("npm", ["pack", packageDir, "--pack-destination", workspace], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const tarballName = output.split("\n").filter(Boolean).at(-1);
    if (!tarballName) throw new Error("npm pack did not report a tarball name");
    return `file:${join(workspace, tarballName)}`;
  } catch (error) {
    throw new Error(`FAIL-INFRA: unable to pack ${IMAGE_PACKAGE_NAME}: ${formatUnknownError(error)}`);
  }
}

function resolveImageAttachmentsDependency(workspace: string): string {
  const candidates = [
    process.env.PI_IMAGE_ATTACHMENTS_PACKAGE_DIR,
    resolve(process.cwd(), "../pi-image-attachments"),
    resolve(process.cwd(), "../../../pi-image-attachments"),
  ];

  for (const candidate of candidates) {
    if (candidate && hasPackageName(candidate, IMAGE_PACKAGE_NAME)) {
      return packLocalImageAttachments(candidate, workspace);
    }
  }

  return "^0.1.1";
}

function runNpmInstall(workspace: string): void {
  try {
    execFileSync("npm", ["install", "--ignore-scripts"], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = isRecord(error)
      ? [error.stdout, error.stderr].filter((value): value is string => typeof value === "string").join("\n")
      : "";
    throw new Error(
      `FAIL-INFRA: npm install --ignore-scripts failed${output ? `\n${output}` : ""}`,
    );
  }
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "pi-vim-image-attachments-e2e-"));
  const packageJson = {
    private: true,
    type: "module",
    dependencies: {
      [IMAGE_PACKAGE_NAME]: resolveImageAttachmentsDependency(workspace),
      "@mariozechner/pi-ai": `file:${findPackageRoot("@mariozechner/pi-ai")}`,
      "@mariozechner/pi-coding-agent": `file:${findPackageRoot("@mariozechner/pi-coding-agent")}`,
      "@mariozechner/pi-tui": `file:${findPackageRoot("@mariozechner/pi-tui")}`,
    },
  };

  await writeFile(join(workspace, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  runNpmInstall(workspace);
  await writeFile(join(workspace, "fixture.png"), PNG_BYTES);
  return workspace;
}

async function importImageAttachmentsExtension(workspace: string): Promise<PiExtension> {
  try {
    const workspaceRequire = createRequire(join(workspace, "package.json"));
    const entry = workspaceRequire.resolve(`${IMAGE_PACKAGE_NAME}/index.ts`);
    const module = await import(pathToFileURL(entry).href) as unknown;

    if (!isRecord(module) || typeof module.default !== "function") {
      throw new Error(`${IMAGE_PACKAGE_NAME} default export is not a function`);
    }

    return module.default as PiExtension;
  } catch (error) {
    throw new Error(`FAIL-INFRA: unable to import ${IMAGE_PACKAGE_NAME}: ${formatUnknownError(error)}`);
  }
}

function createPiHarness() {
  const sentUserMessages: SentUserMessage[] = [];
  const pi = Object.assign(createExtensionApiHarness(), {
    sentUserMessages,
    sendUserMessage(content: unknown, options?: unknown): void {
      sentUserMessages.push({ content, options });
    },
  });

  return pi;
}

function createRuntimeHarness(cwd: string): RuntimeHarness {
  let editorFactory: RuntimeEditorFactory | undefined;
  const widgetCalls: WidgetCall[] = [];
  const notifications: NotificationCall[] = [];

  const ctx: RuntimeContext = {
    cwd,
    hasUI: true,
    isIdle() {
      return true;
    },
    ui: {
      theme: stubTheme,
      setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void {
        widgetCalls.push({ key, content, options });
      },
      setEditorComponent(factory: RuntimeEditorFactory | undefined): void {
        editorFactory = factory;
      },
      getEditorComponent(): RuntimeEditorFactory | undefined {
        return editorFactory;
      },
      notify(message: string, type: string): void {
        notifications.push({ message, type });
      },
    },
    shutdown(): void {},
  };

  return {
    ctx,
    widgetCalls,
    notifications,
    getEditorFactory(): RuntimeEditorFactory {
      if (!editorFactory) throw new Error("expected an installed editor factory");
      return editorFactory;
    },
  };
}

async function installInOrder(
  workspace: string,
  imageExtension: PiExtension,
  order: "image-first" | "vim-first",
): Promise<RuntimeHarness> {
  const pi = createPiHarness();
  const harness = createRuntimeHarness(workspace);

  if (order === "image-first") {
    imageExtension(pi);
    installPiVim(pi);
  } else {
    installPiVim(pi);
    imageExtension(pi);
  }

  await pi.emit("session_start", undefined, harness.ctx);
  return harness;
}

function mountEditor(harness: RuntimeHarness): EditorSurface {
  const editor = harness.getEditorFactory()(stubTui, stubTheme, stubKeybindings);
  assertEditorSurface(editor, "installed editor");
  return editor;
}

function fail(message: string): never {
  throw new Error(message);
}

function crossPackageBlocker(message: string): never {
  fail(`cross-package blocker: ${message}`);
}

function assertEditorSurface(editor: unknown, label: string): asserts editor is EditorSurface {
  if (!isRecord(editor)) fail(`${label} is not an object`);

  for (const method of WRAPPABLE_BASELINE_METHODS) {
    if (typeof editor[method] !== "function") {
      fail(`${label} is missing method ${method}`);
    }
  }

  for (const field of WRAPPABLE_BASELINE_FIELDS) {
    if (!(field in editor)) {
      fail(`${label} is missing field ${field}`);
    }
  }

  if (!(editor.actionHandlers instanceof Map)) fail(`${label} actionHandlers is not a Map`);
  if (typeof editor.borderColor !== "function") fail(`${label} borderColor is not a function`);
  if (typeof editor.focused !== "boolean") fail(`${label} focused is not a boolean`);
  if (typeof editor.disableSubmit !== "boolean") fail(`${label} disableSubmit is not a boolean`);
}

function assertPiVimSurfaceForLaterDecorator(editor: unknown): asserts editor is EditorSurface {
  try {
    assertEditorSurface(editor, "later image-attachments editor");
  } catch (error) {
    crossPackageBlocker(formatUnknownError(error));
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    fail(`${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function typeText(editor: EditorSurface, text: string): void {
  for (const char of text) editor.handleInput(char);
}

function assertImageAttachmentInserted(
  editor: EditorSurface,
  harness: RuntimeHarness,
  imagePath: string,
): void {
  editor.handleInput(bracketedPaste(imagePath));
  assertEqual(editor.getText(), "[Image #1] ", "image paste should insert an attachment placeholder");

  const latestWidget = harness.widgetCalls.at(-1);
  if (!latestWidget?.content) fail("image paste should publish an attachments widget");
  assertIncludes(latestWidget.content.join("\n"), "[Image #1]", "attachments widget should include the placeholder");
}

function assertPiVimModalBehavior(editor: EditorSurface): void {
  assertEqual(editor.getMode(), "insert", "editor should start in INSERT mode");
  typeText(editor, "abc");
  assertEqual(editor.getText(), "abc", "INSERT input should update editor text");

  editor.handleInput("\x1b");
  assertEqual(editor.getMode(), "normal", "escape should enter NORMAL mode");

  editor.handleInput("0");
  editor.handleInput("x");
  assertEqual(
    editor.getText(),
    "bc",
    "NORMAL printable input should be handled by pi-vim instead of inserted as raw text",
  );
}

async function verifyImageThenVim(workspace: string, imageExtension: PiExtension): Promise<void> {
  const imagePath = join(workspace, "fixture.png");

  const imageHarness = await installInOrder(workspace, imageExtension, "image-first");
  assertImageAttachmentInserted(mountEditor(imageHarness), imageHarness, imagePath);

  const modalHarness = await installInOrder(workspace, imageExtension, "image-first");
  assertPiVimModalBehavior(mountEditor(modalHarness));

  console.log("PASS image-attachments then pi-vim");
}

async function verifyVimThenImage(workspace: string, imageExtension: PiExtension): Promise<void> {
  const imagePath = join(workspace, "fixture.png");

  try {
    const surfaceHarness = await installInOrder(workspace, imageExtension, "vim-first");
    assertPiVimSurfaceForLaterDecorator(surfaceHarness.getEditorFactory()(stubTui, stubTheme, stubKeybindings));

    const imageHarness = await installInOrder(workspace, imageExtension, "vim-first");
    const imageEditor = mountEditor(imageHarness);
    assertImageAttachmentInserted(imageEditor, imageHarness, imagePath);
    assertEqual(imageEditor.getMode(), "insert", "image attachment handling should preserve INSERT mode");

    const modalHarness = await installInOrder(workspace, imageExtension, "vim-first");
    assertPiVimModalBehavior(mountEditor(modalHarness));
  } catch (error) {
    const message = formatUnknownError(error);
    if (message.startsWith("cross-package blocker:")) throw error;
    crossPackageBlocker(message);
  }

  console.log("PASS pi-vim then image-attachments");
}

async function main(): Promise<void> {
  const workspace = await createWorkspace();
  console.log("image-attachments-e2e: npm install --ignore-scripts completed");

  const imageExtension = await importImageAttachmentsExtension(workspace);
  await verifyImageThenVim(workspace, imageExtension);
  await verifyVimThenImage(workspace, imageExtension);

  console.log("PASS image-attachments-e2e");
}

void main();
