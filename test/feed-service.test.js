const test = require("node:test");
const assert = require("node:assert/strict");
const { FeedService } = require("../src/feed-service");

test("parses Google News RSS items", () => {
  const service = new FeedService("/tmp");
  const items = service.parseRss(`<?xml version="1.0"?><rss><channel><item><title>Example headline - Example Source</title><link>https://example.com/story</link><pubDate>Sat, 12 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
  assert.deepEqual(items, [{
    title: "Example headline - Example Source",
    link: "https://example.com/story",
    pubDate: "Sat, 12 Jul 2026 10:00:00 GMT"
  }]);
});

test("builds a 24-hour Google News search RSS URL", () => {
  const service = new FeedService("/tmp");
  const url = new URL(service.buildRssUrl("Open AI"));
  assert.equal(url.hostname, "news.google.com");
  assert.equal(url.searchParams.get("q"), "OpenAI when:1d");
  assert.equal(url.searchParams.get("ceid"), "US:en");
});

test("accepts a valid topic feed with no stories as a successful refresh", async () => {
  const service = new FeedService("/tmp");
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("<?xml version=\"1.0\"?><rss><channel><title>Quiet topic</title></channel></rss>", { status: 200 });
  try {
    assert.deepEqual(await service.fetchTopic("Solo Journaling RPG"), []);
  } finally {
    global.fetch = originalFetch;
  }
});
