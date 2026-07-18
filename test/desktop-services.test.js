const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSummaryPrompt,
  candidateCodexPaths,
  summaryKey
} = require("../src/codex-service");
const {
  MAC_INSTALL_SCRIPT,
  isNewerVersion,
  macBundleFromExecutable,
  pickReleaseAsset,
  releaseVersion
} = require("../src/update-service");
const { WeatherService, weatherCondition, weatherUrl } = require("../src/weather-service");

test("version comparison only accepts a newer semantic release", () => {
  assert.equal(isNewerVersion("v1.1.0", "1.0.0"), true);
  assert.equal(isNewerVersion("1.1.0", "1.1.0"), false);
  assert.equal(isNewerVersion("1.0.9", "1.1.0"), false);
  assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
});

test("release assets are selected for the current desktop platform", () => {
  const assets = [
    { name: "The.Last.Hour-1.1.0-arm64-mac.zip" },
    { name: "The.Last.Hour-1.1.0-x64-win.zip" },
    { name: "The.Last.Hour.Setup.1.1.0.exe" }
  ];
  assert.equal(pickReleaseAsset(assets, "darwin", "arm64").name, assets[0].name);
  assert.equal(pickReleaseAsset(assets, "win32", "x64").name, assets[2].name);
  assert.equal(pickReleaseAsset(assets, "linux", "x64"), undefined);
});

test("release and bundle helpers normalize updater metadata", () => {
  assert.equal(releaseVersion({ tag_name: "v1.1.0" }), "1.1.0");
  assert.equal(
    macBundleFromExecutable("/Applications/The Last Hour.app/Contents/MacOS/The Last Hour"),
    "/Applications/The Last Hour.app"
  );
  assert.match(MAC_INSTALL_SCRIPT, /backup_app="\$\{target_app\}\.update-backup"/);
  assert.doesNotMatch(MAC_INSTALL_SCRIPT, /\\\$\{target_app\}/);
});

test("desktop packages include the shared topic data required at startup", () => {
  const packageManifest = require("../package.json");
  assert.ok(packageManifest.build.files.includes("shared/**/*"));
});

test("Codex summary prompts contain the story context and safety constraints", () => {
  const story = {
    title: "A major event happened",
    source: "Example News",
    topic: "World News",
    publishedAt: "2026-07-18T12:00:00.000Z",
    url: "https://example.com/story"
  };
  const prompt = buildSummaryPrompt(story);
  assert.match(prompt, /concise, neutral news summary/i);
  assert.match(prompt, /exactly three brief bullet points/i);
  assert.match(prompt, /https:\/\/example\.com\/story/);
  assert.equal(summaryKey(story), summaryKey({ ...story }));
});

test("Codex path discovery includes standalone and npm installations", () => {
  const windows = candidateCodexPaths("win32", {
    LOCALAPPDATA: "C:\\Users\\News\\AppData\\Local",
    APPDATA: "C:\\Users\\News\\AppData\\Roaming"
  });
  assert.ok(windows.some((value) => value.endsWith("codex.exe")));
  assert.ok(windows.some((value) => value.endsWith("codex.cmd")));
  assert.ok(candidateCodexPaths("darwin", {}).some((value) => value.endsWith(".npm-global/bin/codex")));
});

test("Huntsville weather requests use Fahrenheit current conditions and Central time", () => {
  const url = new URL(weatherUrl());
  assert.equal(url.hostname, "api.open-meteo.com");
  assert.equal(url.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(url.searchParams.get("timezone"), "America/Chicago");
  assert.equal(url.searchParams.get("current"), "temperature_2m,weather_code,is_day");
  assert.deepEqual(weatherCondition(0), { label: "Clear", tone: "clear" });
  assert.deepEqual(weatherCondition(63), { label: "Rainy", tone: "rain" });
  assert.deepEqual(weatherCondition(95), { label: "Thunderstorms", tone: "storm" });
});

test("weather service normalizes and caches current conditions", async () => {
  let calls = 0;
  const service = new WeatherService(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 83.6, weather_code: 2, is_day: 1, time: "2026-07-18T07:15" }
      })
    };
  });
  const first = await service.current();
  const second = await service.current();
  assert.equal(first.temperature, 84);
  assert.equal(first.condition, "Partly Cloudy");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});
