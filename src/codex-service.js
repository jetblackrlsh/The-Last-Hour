const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_LENGTH = 24_000;
const SUMMARY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function summaryKey(story) {
  return crypto.createHash("sha256").update(story.url).digest("hex");
}

function buildSummaryPrompt(story) {
  return [
    "Write a concise, neutral news summary for a reader of The Last Hour.",
    "Use the linked article and current web search to verify the story. Return plain text only:",
    "one short overview paragraph followed by exactly three brief bullet points.",
    "State when an important detail is uncertain or unavailable. Do not add a heading or links.",
    "",
    `Headline: ${story.title}`,
    `Publisher: ${story.source}`,
    `Topic: ${story.topic}`,
    `Published: ${story.publishedAt}`,
    `Article: ${story.url}`
  ].join("\n");
}

function candidateCodexPaths(platform = process.platform, environment = process.env) {
  if (platform === "win32") {
    return [
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      environment.APPDATA && path.join(environment.APPDATA, "npm", "codex.cmd"),
      environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codex.exe")
    ].filter(Boolean);
  }

  const userHome = os.homedir();
  return [
    path.join(userHome, ".local", "bin", "codex"),
    path.join(userHome, ".npm-global", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex"
  ];
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexPath(platform = process.platform, environment = process.env) {
  const lookupCommand = platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(lookupCommand, ["codex"], { windowsHide: true });
    const discovered = stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (discovered && await isExecutable(discovered)) return discovered;
  } catch {
    // Finder-launched macOS apps and Windows shortcuts often have a minimal PATH.
  }

  for (const filePath of candidateCodexPaths(platform, environment)) {
    if (await isExecutable(filePath)) return filePath;
  }
  return "";
}

function runCodex(codexPath, prompt, options = {}) {
  const platform = options.platform || process.platform;
  const timeoutMs = options.timeoutMs || 180_000;
  const codexArgs = [
    "--search",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-"
  ];
  const command = platform === "win32" && codexPath.toLowerCase().endsWith(".cmd")
    ? (process.env.ComSpec || "cmd.exe")
    : codexPath;
  const args = command === codexPath ? codexArgs : ["/d", "/s", "/c", codexPath, ...codexArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || os.tmpdir(),
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Codex took too long to summarize this story.")));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const summary = stdout.trim();
      if (code === 0 && summary) return resolve(summary);
      const detail = stderr.trim().split(/\r?\n/).at(-1);
      reject(new Error(detail || "Codex could not summarize this story."));
    }));
    child.stdin.end(prompt);
  });
}

class CodexSummaryService {
  constructor(userDataPath, options = {}) {
    this.cachePath = path.join(userDataPath, "codex-summaries.json");
    this.platform = options.platform || process.platform;
    this.run = options.run || runCodex;
    this.cache = {};
  }

  async init() {
    try {
      this.cache = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
    } catch {
      this.cache = {};
    }
  }

  async availability() {
    const executable = await resolveCodexPath(this.platform);
    return { available: Boolean(executable), executable };
  }

  async summarize(story) {
    if (!story || typeof story.url !== "string" || !story.url.startsWith("https://")) {
      throw new Error("This story does not have a valid secure URL.");
    }
    const safeStory = {
      title: String(story.title || "Untitled story").slice(0, 500),
      source: String(story.source || "Unknown publisher").slice(0, 200),
      topic: String(story.topic || "News").slice(0, 200),
      publishedAt: String(story.publishedAt || "Unknown").slice(0, 100),
      url: story.url.slice(0, 2_000)
    };
    const key = summaryKey(safeStory);
    const cached = this.cache[key];
    if (cached && Date.now() - new Date(cached.createdAt).getTime() < SUMMARY_TTL_MS) {
      return { summary: cached.summary, cached: true };
    }

    const codexPath = await resolveCodexPath(this.platform);
    if (!codexPath) {
      throw new Error("Codex CLI was not found. Install Codex and sign in, then try again.");
    }
    const summary = await this.run(codexPath, buildSummaryPrompt(safeStory), { platform: this.platform });
    this.cache[key] = { summary, createdAt: new Date().toISOString(), url: safeStory.url };
    await fs.writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), "utf8");
    return { summary, cached: false };
  }
}

module.exports = {
  CodexSummaryService,
  buildSummaryPrompt,
  candidateCodexPaths,
  resolveCodexPath,
  runCodex,
  summaryKey
};
