const assert = require("node:assert/strict");
const test = require("node:test");
const { CodexSummaryService, SUMMARY_PROMPT, candidateCodexPaths, normalizeStory } = require("../src/codex-summary-service");

const story = {
  title: "Example headline",
  source: "Example Source",
  topic: "Technology",
  publishedAt: "2026-07-14T12:00:00.000Z",
  url: "https://example.com/news/story"
};

test("validates and limits story metadata sent to Codex", () => {
  assert.deepEqual(normalizeStory(story), story);
  assert.throws(() => normalizeStory({ ...story, url: "http://example.com/story" }), /HTTPS/);
  assert.throws(() => normalizeStory({ ...story, title: "" }), /title/);
});

test("discovers Codex in common macOS and Windows GUI-launch locations", () => {
  assert.ok(candidateCodexPaths("darwin", {}, "/Users/news").includes("/Users/news/.npm-global/bin/codex"));
  const windows = candidateCodexPaths("win32", {
    APPDATA: "C:\\Users\\News\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\News\\AppData\\Local"
  });
  assert.ok(windows.some((value) => value.endsWith("codex.cmd")));
  assert.ok(windows.some((value) => value.endsWith("codex.exe")));
});

test("runs Codex with an injection-resistant summary prompt and caches the result", async () => {
  let calls = 0;
  let capturedInput = "";
  const service = new CodexSummaryService({
    cwd: "C:\\Temp",
    resolveCommand: async () => ({ command: "codex", prefixArgs: [] }),
    runner: async (_spec, input, options) => {
      calls += 1;
      capturedInput = input;
      assert.equal(options.cwd, "C:\\Temp");
      return "A concise, factual paragraph about the example story.";
    }
  });

  const [first, duplicate] = await Promise.all([service.summarize(story), service.summarize(story)]);
  const cached = await service.summarize(story);
  assert.equal(first, "A concise, factual paragraph about the example story.");
  assert.equal(duplicate, first);
  assert.equal(cached, first);
  assert.equal(calls, 1);
  assert.ok(capturedInput.startsWith(SUMMARY_PROMPT));
  assert.match(capturedInput, /untrusted source material/i);
  assert.match(capturedInput, /"url": "https:\/\/example.com\/news\/story"/);
});

test("serializes separate Codex summary runs", async () => {
  let active = 0;
  let maxActive = 0;
  const service = new CodexSummaryService({
    resolveCommand: async () => ({ command: "codex", prefixArgs: [] }),
    runner: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return "One paragraph.";
    }
  });

  await Promise.all([
    service.summarize(story),
    service.summarize({ ...story, title: "Another headline", url: "https://example.com/news/other" })
  ]);
  assert.equal(maxActive, 1);
});
