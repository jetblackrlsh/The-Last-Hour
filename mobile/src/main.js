import "./styles.css";
import { Browser } from "@capacitor/browser";
import { CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import topicConfig from "../../shared/topics.json";

const CACHE_KEY = "the-last-hour-mobile-cache-v1";
const FRESH_FOR_MS = 10 * 60 * 1000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const allTopics = topicConfig.subjectGroups.flatMap((group) => group.topics);

const state = {
  feeds: {}, mode: "topic", groupIndex: 0, topic: allTopics[0], hours: 24,
  selected: new Set(allTopics), loading: new Set(), failed: new Set(), visibleCount: 20
};

const ids = ["brandButton", "statusButton", "statusText", "aboutButton", "subjectRail", "topicRail", "modeKicker", "viewTitle", "windowToggle", "filterButton", "filterCount", "refreshButton", "signalLabel", "dataMode", "progressBar", "syncDescription", "storyStream", "streamSentinel", "pullIndicator", "filterSheet", "filterClose", "filterGroups", "selectAll", "clearAll", "aboutSheet", "aboutClose"];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function splitHeadline(fullTitle) {
  const divider = fullTitle.lastIndexOf(" - ");
  return divider < 1 ? { title: fullTitle, source: "Google News" } : { title: fullTitle.slice(0, divider).trim(), source: fullTitle.slice(divider + 3).trim() || "Google News" };
}

function stableId(url) {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1) { hash ^= url.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `story-${(hash >>> 0).toString(16)}`;
}

function timeAgo(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? "NOW" : minutes >= 60 ? `${Math.floor(minutes / 60)}H AGO` : `${minutes}M AGO`;
}

function buildRssUrl(topic) {
  const params = new URLSearchParams({ q: `${topicConfig.queryOverrides[topic] || topic} when:1d`, hl: "en-US", gl: "US", ceid: "US:en" });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

function parseRss(xml) {
  const documentNode = new DOMParser().parseFromString(xml, "application/xml");
  if (documentNode.querySelector("parsererror") || !documentNode.querySelector("rss channel")) throw new Error("Invalid Google News feed");
  return [...documentNode.querySelectorAll("item")].map((item) => ({
    title: item.querySelector("title")?.textContent?.trim() || "",
    link: item.querySelector("link")?.textContent?.trim() || "",
    pubDate: item.querySelector("pubDate")?.textContent?.trim() || ""
  })).filter((item) => item.title && item.link && item.pubDate);
}

async function saveCache() {
  await Preferences.set({ key: CACHE_KEY, value: JSON.stringify({ version: 1, feeds: state.feeds }) });
}

async function loadCache() {
  try {
    const { value } = await Preferences.get({ key: CACHE_KEY });
    const parsed = JSON.parse(value || "{}");
    const cutoff = Date.now() - MAX_CACHE_AGE_MS;
    state.feeds = Object.fromEntries(Object.entries(parsed.feeds || {}).filter(([, feed]) => new Date(feed.fetchedAt || 0).getTime() >= cutoff && Array.isArray(feed.items)));
  } catch { state.feeds = {}; }
}

function isFresh(topic) {
  const feed = state.feeds[topic];
  return Boolean(Array.isArray(feed?.items) && Date.now() - new Date(feed.fetchedAt).getTime() < FRESH_FOR_MS);
}

async function fetchTopic(topic) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await CapacitorHttp.get({
        url: buildRssUrl(topic), responseType: "text", connectTimeout: 12000, readTimeout: 12000,
        headers: { Accept: "application/rss+xml, application/xml;q=0.9", "Accept-Language": "en-US,en;q=0.9" }
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Google News returned ${response.status}`);
      return parseRss(typeof response.data === "string" ? response.data : String(response.data || ""));
    } catch (error) {
      lastError = error;
      if (attempt === 0) await delay(900);
    }
  }
  throw lastError || new Error("Refresh failed");
}

async function refreshTopic(topic, force = false) {
  if (!force && isFresh(topic)) return { topic, ok: true, feed: state.feeds[topic] };
  state.loading.add(topic); state.failed.delete(topic); renderStatus();
  try {
    const items = await fetchTopic(topic);
    state.feeds[topic] = { topic, fetchedAt: new Date().toISOString(), items };
    await saveCache(); state.loading.delete(topic); render();
    return { topic, ok: true, feed: state.feeds[topic] };
  } catch (error) {
    state.loading.delete(topic); state.failed.add(topic); render();
    return { topic, ok: false, error: error?.message || "Refresh failed" };
  }
}

async function refreshAll(force = false) {
  let cursor = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (cursor < allTopics.length) {
      const index = cursor; cursor += 1;
      await refreshTopic(allTopics[index], force); await delay(220);
    }
  });
  await Promise.all(workers); render();
}

function activeTopics() { return state.mode === "topic" ? [state.topic] : [...state.selected]; }

function buildStories() {
  const allowed = new Set(activeTopics());
  const cutoff = Date.now() - state.hours * 60 * 60 * 1000;
  return Object.values(state.feeds).filter((feed) => allowed.has(feed.topic)).flatMap((feed) => feed.items.map((item) => ({ ...item, topic: feed.topic }))).map((item) => {
    const headline = splitHeadline(item.title);
    return { id: stableId(item.link), title: headline.title, source: headline.source, url: item.link, publishedAt: new Date(item.pubDate).toISOString(), topic: item.topic };
  }).filter((story) => new Date(story.publishedAt).getTime() >= cutoff).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).filter((story, index, list) => list.findIndex((candidate) => candidate.url === story.url) === index);
}

function renderNav() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  el.subjectRail.innerHTML = topicConfig.subjectGroups.map((group, index) => `<button class="subject-chip ${index === state.groupIndex ? "active" : ""}" data-group="${index}"><span>${group.code}</span>${escapeHtml(group.name)}</button>`).join("");
  el.topicRail.hidden = state.mode !== "topic";
  el.topicRail.innerHTML = topicConfig.subjectGroups[state.groupIndex].topics.map((topic) => `<button class="topic-chip ${topic === state.topic ? "active" : ""}" data-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("");
}

function renderFilters() {
  el.filterCount.textContent = state.selected.size;
  el.filterGroups.innerHTML = topicConfig.subjectGroups.map((group) => `<section class="filter-group"><h3>${group.code} · ${escapeHtml(group.name)}</h3><div>${group.topics.map((topic) => `<button class="filter-topic ${state.selected.has(topic) ? "active" : ""}" data-filter-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("")}</div></section>`).join("");
}

function renderStatus() {
  const completed = Object.keys(state.feeds).length + state.failed.size;
  const loading = state.loading.size > 0;
  el.statusButton.classList.toggle("loading", loading);
  el.statusText.textContent = loading ? `${state.loading.size} LIVE` : "LOCAL";
  el.refreshButton.classList.toggle("loading", loading);
  el.progressBar.style.width = `${Math.min(100, completed / allTopics.length * 100)}%`;
}

function renderStories() {
  const stories = buildStories();
  const topics = activeTopics();
  const failedActive = topics.filter((topic) => state.failed.has(topic));
  const titles = { topic: state.topic, ultra: "Ultra Feed", super: "Super Feed" };
  const kickers = { topic: "F01 · FOCUSED SIGNAL", ultra: "U02 · COMBINED OBSERVATORY", super: "S03 · CONTINUOUS SIGNAL" };
  el.viewTitle.textContent = titles[state.mode]; el.modeKicker.textContent = kickers[state.mode];
  el.signalLabel.textContent = state.hours === 1 ? "LATEST ONE-HOUR SIGNALS" : "LATEST 24-HOUR SIGNALS";
  el.dataMode.textContent = failedActive.length ? "LIVE + SAVED" : topics.some((topic) => state.feeds[topic]) ? "LOCAL LIVE" : "NO CACHE";
  el.syncDescription.textContent = state.loading.size ? `Refreshing ${state.loading.size} topic${state.loading.size === 1 ? "" : "s"} directly through this phone.` : failedActive.length ? `${failedActive.length} refresh failure${failedActive.length === 1 ? "" : "s"}; saved stories remain visible.` : `${stories.length} stories across ${new Set(stories.map((story) => story.topic)).size} active topics.`;
  el.windowToggle.hidden = state.mode === "super";
  document.querySelectorAll("[data-hours]").forEach((button) => button.classList.toggle("active", Number(button.dataset.hours) === state.hours));
  document.body.classList.toggle("super-mode", state.mode === "super");

  if (!stories.length) {
    el.storyStream.innerHTML = `<div class="empty-state"><div><strong>No signals in this window.</strong>${state.loading.size ? "A local refresh is still in progress." : "Try the 24-hour window or refresh this feed."}</div></div>`;
    el.streamSentinel.hidden = true; return;
  }
  const visible = stories.slice(0, state.mode === "super" ? state.visibleCount : stories.length);
  const lead = visible[0]; const rows = state.mode === "super" ? visible : visible.slice(1);
  el.storyStream.innerHTML = `${state.mode === "super" ? "" : `<article class="lead-story" data-url="${escapeHtml(lead.url)}"><div class="story-meta"><span>${escapeHtml(lead.topic)}</span><span>${escapeHtml(lead.source)} · ${timeAgo(lead.publishedAt)}</span></div><h2>${escapeHtml(lead.title)}</h2><span class="open-signal">OPEN SIGNAL ↗</span></article>`}<div class="story-list">${rows.map((story, index) => `<article class="story-row" data-url="${escapeHtml(story.url)}"><span class="story-index">${String(index + (state.mode === "super" ? 1 : 2)).padStart(3, "0")}</span><div class="story-copy"><div class="story-meta"><span>${escapeHtml(story.topic)}</span><span>${escapeHtml(story.source)} · ${timeAgo(story.publishedAt)}</span></div><h3>${escapeHtml(story.title)}</h3></div><span class="story-arrow">↗</span></article>`).join("")}</div>`;
  el.streamSentinel.hidden = state.mode !== "super";
  el.streamSentinel.textContent = state.visibleCount < stories.length ? "SCROLL FOR MORE SIGNALS" : "END OF CURRENT 24-HOUR WINDOW";
}

function render() { renderNav(); renderFilters(); renderStatus(); renderStories(); }

function setMode(mode) { state.mode = mode; if (mode === "super") state.hours = 24; state.visibleCount = 20; render(); }

document.addEventListener("click", async (event) => {
  const mode = event.target.closest("[data-mode]"); if (mode) return setMode(mode.dataset.mode);
  const group = event.target.closest("[data-group]"); if (group) { state.groupIndex = Number(group.dataset.group); if (state.mode === "topic") { state.topic = topicConfig.subjectGroups[state.groupIndex].topics[0]; render(); await refreshTopic(state.topic); } else render(); return; }
  const topic = event.target.closest("[data-topic]"); if (topic) { state.topic = topic.dataset.topic; state.mode = "topic"; render(); await refreshTopic(state.topic); return; }
  const filter = event.target.closest("[data-filter-topic]"); if (filter) { state.selected.has(filter.dataset.filterTopic) ? state.selected.delete(filter.dataset.filterTopic) : state.selected.add(filter.dataset.filterTopic); render(); return; }
  const hours = event.target.closest("[data-hours]"); if (hours) { state.hours = Number(hours.dataset.hours); render(); return; }
  const story = event.target.closest("[data-url]"); if (story) await Browser.open({ url: story.dataset.url });
});

el.brandButton.addEventListener("click", () => setMode("topic"));
el.refreshButton.addEventListener("click", () => state.mode === "topic" ? refreshTopic(state.topic, true) : refreshAll(true));
el.filterButton.addEventListener("click", () => el.filterSheet.showModal());
el.filterClose.addEventListener("click", () => el.filterSheet.close());
el.selectAll.addEventListener("click", () => { state.selected = new Set(allTopics); render(); });
el.clearAll.addEventListener("click", () => { state.selected.clear(); render(); });
el.aboutButton.addEventListener("click", () => el.aboutSheet.showModal());
el.aboutClose.addEventListener("click", () => el.aboutSheet.close());

const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting && state.mode === "super") { state.visibleCount += 20; renderStories(); } }, { rootMargin: "400px" });
observer.observe(el.streamSentinel);

let touchStart = 0;
window.addEventListener("touchstart", (event) => { if (window.scrollY <= 0) touchStart = event.touches[0].clientY; }, { passive: true });
window.addEventListener("touchmove", (event) => { if (touchStart && event.touches[0].clientY - touchStart > 45) el.pullIndicator.classList.add("visible"); }, { passive: true });
window.addEventListener("touchend", (event) => { const pulled = touchStart && event.changedTouches[0].clientY - touchStart > 80; touchStart = 0; el.pullIndicator.classList.remove("visible"); if (pulled && !state.loading.size) state.mode === "topic" ? refreshTopic(state.topic, true) : refreshAll(true); }, { passive: true });

async function start() { await loadCache(); render(); await refreshAll(false); }
start();
setInterval(() => refreshAll(false), 15 * 60 * 1000);
