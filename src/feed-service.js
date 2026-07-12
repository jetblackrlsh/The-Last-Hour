const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");
const { allTopics, queryOverrides, subjectGroups } = require("./topics");

const FRESH_FOR_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") return value["#text"] || "";
  return "";
}

class FeedService extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.cachePath = path.join(userDataPath, "feed-cache.json");
    this.cache = {};
    this.saveChain = Promise.resolve();
    this.parser = new XMLParser({
      ignoreAttributes: false,
      trimValues: true,
      processEntities: true
    });
  }

  async init() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
      const cutoff = Date.now() - MAX_CACHE_AGE_MS;
      this.cache = Object.fromEntries(
        Object.entries(parsed.feeds || {}).filter(([, feed]) => {
          const fetched = new Date(feed.fetchedAt || 0).getTime();
          return Number.isFinite(fetched) && fetched >= cutoff && Array.isArray(feed.items);
        })
      );
    } catch {
      this.cache = {};
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      feeds: this.cache,
      topics: allTopics,
      subjectGroups,
      generatedAt: new Date().toISOString()
    };
  }

  buildRssUrl(topic) {
    const params = new URLSearchParams({
      q: `${queryOverrides[topic] || topic} when:1d`,
      hl: "en-US",
      gl: "US",
      ceid: "US:en"
    });
    return `https://news.google.com/rss/search?${params.toString()}`;
  }

  parseRss(xml) {
    const parsed = this.parser.parse(xml);
    const channel = parsed?.rss?.channel;
    return asArray(channel?.item)
      .map((item) => ({
        title: asText(item.title).trim(),
        link: asText(item.link).trim(),
        pubDate: asText(item.pubDate).trim()
      }))
      .filter((item) => item.title && item.link && item.pubDate);
  }

  async fetchTopic(topic) {
    const url = this.buildRssUrl(topic);
    let lastError = new Error("No stories returned");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36"
          }
        });
        if (!response.ok) throw new Error(`Google News returned ${response.status}`);
        const xml = await response.text();
        if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
          throw new Error("Google News returned an invalid feed");
        }
        const items = this.parseRss(xml);
        return items;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0) await delay(900);
      }
    }
    throw lastError;
  }

  isFresh(topic) {
    const fetched = new Date(this.cache[topic]?.fetchedAt || 0).getTime();
    return Boolean(Array.isArray(this.cache[topic]?.items) && Date.now() - fetched < FRESH_FOR_MS);
  }

  async refreshTopic(topic, options = {}) {
    if (!allTopics.includes(topic)) throw new Error("Unknown topic");
    if (!options.force && this.isFresh(topic)) {
      return { topic, ok: true, cached: true, feed: this.cache[topic] };
    }

    this.emit("progress", { topic, state: "loading" });
    try {
      const items = await this.fetchTopic(topic);
      this.cache[topic] = { topic, fetchedAt: new Date().toISOString(), items };
      await this.queueSave();
      const result = { topic, ok: true, cached: false, feed: this.cache[topic] };
      this.emit("progress", { topic, state: "complete", result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Refresh failed";
      const result = {
        topic,
        ok: false,
        cached: Boolean(this.cache[topic]?.items?.length),
        feed: this.cache[topic] || null,
        error: message
      };
      this.emit("progress", { topic, state: "failed", result });
      return result;
    }
  }

  async refreshAll(options = {}) {
    let cursor = 0;
    const results = [];
    const workers = Array.from({ length: 2 }, async () => {
      while (cursor < allTopics.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await this.refreshTopic(allTopics[index], options);
        await delay(250);
      }
    });
    await Promise.all(workers);
    return { ...this.snapshot(), results };
  }

  queueSave() {
    const payload = JSON.stringify({ version: 1, feeds: this.cache }, null, 2);
    const temporaryPath = `${this.cachePath}.tmp`;
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(temporaryPath, payload, "utf8");
        await fs.rename(temporaryPath, this.cachePath);
      });
    return this.saveChain;
  }
}

module.exports = { FeedService };
