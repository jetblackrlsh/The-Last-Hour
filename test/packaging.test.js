const assert = require("node:assert/strict");
const test = require("node:test");
const packageJson = require("../package.json");

test("desktop package includes shared topic data", () => {
  assert.ok(
    packageJson.build.files.includes("shared/**/*"),
    "Electron builds must include shared/topics.json"
  );
});
