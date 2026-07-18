import "./styles.css";
import { Browser } from "@capacitor/browser";
import { CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import topicConfig from "../../shared/topics.json";

const MobileAi = registerPlugin("MobileAi");
const CACHE_KEY = "the-last-hour-mobile-cache-v1";
const FRESH_FOR_MS = 10 * 60 * 1000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const allTopics = topicConfig.subjectGroups.flatMap((group) => group.topics);

const state = {
  feeds: {}, mode: "topic", groupIndex: 0, topic: allTopics[0], hours: 24,
  selected: new Set(allTopics), loading: new Set(), failed: new Set(), visibleCount: 20,
  summaries: new Map(), aiConfigured: false, activeSpeech: null
};

const ids = [
  "brandButton", "statusButton", "statusText", "aiButton", "aboutButton", "subjectRail", "topicRail",
  "modeKicker", "viewTitle", "windowToggle", "filterButton", "filterCount", "refreshButton", "signalLabel",
  "dataMode", "progressBar", "syncDescription", "storyStream", "streamSentinel", "pullIndicator", "filterSheet",
  "filterClose", "filterGroups", "selectAll", "clearAll", "aboutSheet", "aboutClose", "aiSheet", "aiClose",
  "aiKeyForm", "aiKeyInput", "aiKeyReveal", "aiSaveButton", "aiKeyStatus", "aiDeleteButton"
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function splitHeadline(fullTitle) {
  const divider = fullTitle.lastIndexOf(" - ");
  return divider < 1 ? { title: fullTitle, source: "Google News" } : { title: fullTitle.slice(0, divider).trim(), source: fullTitle.slice(divider + 3).trim() || "Google News" };
}

function stableId(url) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) { hash ^= url.charCodeAt(index); hash = Math.imul(hash, 16777619); }
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
  return Object.values(state.feeds)
    .filter((feed) => allowed.has(feed.topic))
    .flatMap((feed) => feed.items.map((item) => ({ ...item, topic: feed.topic })))
    .map((item) => {
      const headline = splitHeadline(item.title);
      return { id: stableId(item.link), title: headline.title, source: headline.source, url: item.link, publishedAt: new Date(item.pubDate).toISOString(), topic: item.topic };
    })
    .filter((story) => new Date(story.publishedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .filter((story, index, list) => list.findIndex((candidate) => candidate.url === story.url) === index);
}

function renderNav() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  el.subjectRail.innerHTML = topicConfig.subjectGroups.map((group, index) => `<button class="subject-chip ${index === state.groupIndex ? "active" : ""}" data-group="${index}"><span>${group.code}</span>${escapeHtml(group.name)}</button>`).join("");
  el.topicRail.hidden = state.mode !== "topic";
  el.topicRail.innerHTML = topicConfig.subjectGroups[state.groupIndex].topics.map((topic) => `<button class="topic-chip ${topic === state.topic ? "active" : ""}" data-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("");
}

function renderFilters() {
  el.filterCount.textContent = state.selected.size;
  el.filterGroups.innerHTML = topicConfig.subjectGroups.map((group) => `<section class="filter-group"><h3>${group.code} &middot; ${escapeHtml(group.name)}</h3><div>${group.topics.map((topic) => `<button class="filter-topic ${state.selected.has(topic) ? "active" : ""}" data-filter-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("")}</div></section>`).join("");
}

function renderStatus() {
  const completed = Object.keys(state.feeds).length + state.failed.size;
  const loading = state.loading.size > 0;
  el.statusButton.classList.toggle("loading", loading);
  el.statusText.textContent = loading ? `${state.loading.size} LIVE` : "LOCAL";
  el.refreshButton.classList.toggle("loading", loading);
  el.progressBar.style.width = `${Math.min(100, completed / allTopics.length * 100)}%`;
  el.aiButton.classList.toggle("configured", state.aiConfigured);
  el.aiButton.setAttribute("aria-label", state.aiConfigured ? "AI summary settings, key configured" : "AI summary settings, key required");
}

function summaryMarkup(story) {
  const item = state.summaries.get(story.id);
  const expanded = Boolean(item?.expanded);
  const speaking = state.activeSpeech === story.id;
  const label = item?.status === "loading" ? "SUMMARIZING..." : item?.status === "ready" ? expanded ? "HIDE SUMMARY" : "SHOW SUMMARY" : item?.status === "error" ? "RETRY SUMMARY" : "SUMMARIZE";
  const button = `<button class="summarize-button ${item?.status || ""}" data-summarize="${escapeHtml(story.id)}" aria-controls="summary-${escapeHtml(story.id)}" aria-expanded="${expanded}" ${item?.status === "loading" ? "disabled" : ""}><span>&#10022;</span>${label}</button>`;
  if (!item || !expanded) return { button, panel: "" };

  const content = item.status === "loading"
    ? `<div class="summary-loading"><i></i><span>Reading the publisher article, then asking Gemma...</span></div>`
    : item.status === "error"
      ? `<p class="summary-error">${escapeHtml(item.error)}</p>`
      : `<div class="summary-content"><p>${escapeHtml(item.text)}</p><div class="summary-audio"><button class="read-aloud-button${speaking ? " speaking" : ""}" data-read-aloud="${escapeHtml(story.id)}" aria-pressed="${speaking}"><span>${speaking ? "&#9632;" : "&#9654;"}</span>${speaking ? "STOP READING" : "READ ALOUD"}</button><small>ANDROID SYSTEM VOICE</small></div></div>`;
  return {
    button,
    panel: `<section class="story-summary ${item.status}" id="summary-${escapeHtml(story.id)}" aria-live="polite"><div class="summary-label"><span>GEMMA 4 31B BRIEF</span><small>AI-GENERATED &middot; VERIFY IMPORTANT DETAILS</small></div>${content}</section>`
  };
}

function storyEntry(story, index, isLead = false) {
  const summary = summaryMarkup(story);
  if (isLead) {
    return `<div class="story-entry lead-entry"><article class="lead-story" data-url="${escapeHtml(story.url)}"><div class="story-meta"><span>${escapeHtml(story.topic)}</span><span>${escapeHtml(story.source)} &middot; ${timeAgo(story.publishedAt)}</span></div><h2>${escapeHtml(story.title)}</h2><div class="story-actions">${summary.button}<button class="open-signal" data-open-url="${escapeHtml(story.url)}">OPEN SIGNAL &#8599;</button></div></article>${summary.panel}</div>`;
  }
  return `<div class="story-entry row-entry"><article class="story-row" data-url="${escapeHtml(story.url)}"><span class="story-index">${String(index).padStart(3, "0")}</span><div class="story-copy"><div class="story-meta"><span>${escapeHtml(story.topic)}</span><span>${escapeHtml(story.source)} &middot; ${timeAgo(story.publishedAt)}</span></div><h3>${escapeHtml(story.title)}</h3><div class="row-actions">${summary.button}<button class="story-arrow" data-open-url="${escapeHtml(story.url)}" aria-label="Open ${escapeHtml(story.title)}">&#8599;</button></div></div></article>${summary.panel}</div>`;
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
  el.storyStream.innerHTML = `${state.mode === "super" ? "" : storyEntry(lead, 1, true)}<div class="story-list">${rows.map((story, index) => storyEntry(story, index + (state.mode === "super" ? 1 : 2))).join("")}</div>`;
  el.streamSentinel.hidden = state.mode !== "super";
  el.streamSentinel.textContent = state.visibleCount < stories.length ? "SCROLL FOR MORE SIGNALS" : "END OF CURRENT 24-HOUR WINDOW";
}

function render() { renderNav(); renderFilters(); renderStatus(); renderStories(); }

async function stopReading(storyId = null, rerender = true) {
  if (!state.activeSpeech || (storyId && state.activeSpeech !== storyId)) return;
  try { await MobileAi.stopSpeaking(); } catch { /* The native voice may already be stopped. */ }
  state.activeSpeech = null;
  if (rerender) renderStories();
}

async function readSummary(storyId) {
  if (state.activeSpeech === storyId) return stopReading(storyId);
  const summary = state.summaries.get(storyId);
  if (summary?.status !== "ready" || !summary.text) return;
  await stopReading(null, false);
  try {
    await MobileAi.speak({ storyId, text: summary.text });
    state.activeSpeech = storyId;
    renderStories();
  } catch (error) {
    summary.audioError = error?.message || "Android could not read this summary.";
    renderStories();
  }
}

async function summarizeStory(storyId) {
  const existing = state.summaries.get(storyId);
  if (existing?.status === "loading") return;
  if (existing?.status === "ready") {
    if (existing.expanded) await stopReading(storyId, false);
    existing.expanded = !existing.expanded;
    renderStories();
    return;
  }
  if (!state.aiConfigured) {
    openAiSettings("Add your own Google AI Studio key before requesting a summary.", "notice");
    return;
  }

  const story = buildStories().find((item) => item.id === storyId);
  if (!story) return;
  state.summaries.set(storyId, { status: "loading", expanded: true });
  renderStories();
  try {
    const result = await MobileAi.summarize({ story });
    state.summaries.set(storyId, { status: "ready", expanded: true, text: result.summary, articleUrl: result.articleUrl });
  } catch (error) {
    state.summaries.set(storyId, { status: "error", expanded: true, error: error?.message || "Gemma could not create a summary." });
  }
  renderStories();
}

function setMode(mode) {
  stopReading();
  state.mode = mode;
  if (mode === "super") state.hours = 24;
  state.visibleCount = 20;
  render();
}

function setAiStatus(message, tone = "") {
  el.aiKeyStatus.textContent = message;
  el.aiKeyStatus.className = `ai-key-status ${tone}`.trim();
}

function renderAiSettings() {
  el.aiDeleteButton.hidden = !state.aiConfigured;
  el.aiSaveButton.textContent = state.aiConfigured ? "VERIFY & REPLACE KEY" : "VERIFY & SAVE KEY";
  if (state.aiConfigured) setAiStatus("A Gemma 4 31B API key is secured on this phone.", "success");
  else if (!el.aiKeyStatus.textContent) setAiStatus("No API key is stored on this phone.", "neutral");
  renderStatus();
}

function openAiSettings(message = "", tone = "") {
  renderAiSettings();
  if (message) setAiStatus(message, tone);
  if (!el.aiSheet.open) el.aiSheet.showModal();
}

async function refreshAiStatus() {
  try {
    const result = await MobileAi.getStatus();
    state.aiConfigured = Boolean(result.configured);
  } catch {
    state.aiConfigured = false;
  }
  renderAiSettings();
}

document.addEventListener("click", async (event) => {
  const readButton = event.target.closest("[data-read-aloud]");
  if (readButton) { event.stopPropagation(); return readSummary(readButton.dataset.readAloud); }
  const summaryButton = event.target.closest("[data-summarize]");
  if (summaryButton) { event.stopPropagation(); return summarizeStory(summaryButton.dataset.summarize); }
  const openButton = event.target.closest("[data-open-url]");
  if (openButton) { event.stopPropagation(); return Browser.open({ url: openButton.dataset.openUrl }); }
  const mode = event.target.closest("[data-mode]"); if (mode) return setMode(mode.dataset.mode);
  const group = event.target.closest("[data-group]"); if (group) { state.groupIndex = Number(group.dataset.group); if (state.mode === "topic") { state.topic = topicConfig.subjectGroups[state.groupIndex].topics[0]; render(); await refreshTopic(state.topic); } else render(); return; }
  const topic = event.target.closest("[data-topic]"); if (topic) { await stopReading(); state.topic = topic.dataset.topic; state.mode = "topic"; render(); await refreshTopic(state.topic); return; }
  const filter = event.target.closest("[data-filter-topic]"); if (filter) { state.selected.has(filter.dataset.filterTopic) ? state.selected.delete(filter.dataset.filterTopic) : state.selected.add(filter.dataset.filterTopic); render(); return; }
  const hours = event.target.closest("[data-hours]"); if (hours) { await stopReading(); state.hours = Number(hours.dataset.hours); render(); return; }
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
el.aiButton.addEventListener("click", () => openAiSettings());
el.aiClose.addEventListener("click", () => { el.aiKeyInput.value = ""; el.aiSheet.close(); });
el.aiKeyReveal.addEventListener("click", () => {
  const reveal = el.aiKeyInput.type === "password";
  el.aiKeyInput.type = reveal ? "text" : "password";
  el.aiKeyReveal.textContent = reveal ? "HIDE" : "SHOW";
  el.aiKeyReveal.setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
});
el.aiKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = el.aiKeyInput.value.trim();
  if (!apiKey) return setAiStatus("Paste your Google AI Studio API key first.", "error");
  el.aiSaveButton.disabled = true;
  el.aiSaveButton.textContent = "VERIFYING WITH GOOGLE...";
  setAiStatus("Checking access to Gemma 4 31B...", "notice");
  try {
    await MobileAi.saveApiKey({ apiKey });
    state.aiConfigured = true;
    el.aiKeyInput.value = "";
    el.aiKeyInput.type = "password";
    el.aiKeyReveal.textContent = "SHOW";
    renderAiSettings();
  } catch (error) {
    el.aiKeyInput.value = "";
    setAiStatus(error?.message || "The API key could not be verified.", "error");
  } finally {
    el.aiSaveButton.disabled = false;
    el.aiSaveButton.textContent = state.aiConfigured ? "VERIFY & REPLACE KEY" : "VERIFY & SAVE KEY";
  }
});
el.aiDeleteButton.addEventListener("click", async () => {
  el.aiDeleteButton.disabled = true;
  try {
    await MobileAi.deleteApiKey();
    await stopReading();
    state.aiConfigured = false;
    state.summaries.clear();
    setAiStatus("The API key and cached summaries were removed from this phone.", "success");
    renderAiSettings();
    renderStories();
  } catch (error) {
    setAiStatus(error?.message || "The API key could not be removed.", "error");
  } finally {
    el.aiDeleteButton.disabled = false;
  }
});

const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting && state.mode === "super") { state.visibleCount += 20; renderStories(); } }, { rootMargin: "400px" });
observer.observe(el.streamSentinel);

let touchStart = 0;
window.addEventListener("touchstart", (event) => { if (window.scrollY <= 0) touchStart = event.touches[0].clientY; }, { passive: true });
window.addEventListener("touchmove", (event) => { if (touchStart && event.touches[0].clientY - touchStart > 45) el.pullIndicator.classList.add("visible"); }, { passive: true });
window.addEventListener("touchend", (event) => { const pulled = touchStart && event.changedTouches[0].clientY - touchStart > 80; touchStart = 0; el.pullIndicator.classList.remove("visible"); if (pulled && !state.loading.size) state.mode === "topic" ? refreshTopic(state.topic, true) : refreshAll(true); }, { passive: true });
window.addEventListener("beforeunload", () => stopReading(null, false));

async function start() {
  await loadCache();
  await refreshAiStatus();
  try {
    await MobileAi.addListener("speechState", ({ state: speechState, storyId }) => {
      if (speechState === "started") state.activeSpeech = storyId;
      if ((speechState === "finished" || speechState === "error") && state.activeSpeech === storyId) state.activeSpeech = null;
      renderStories();
    });
  } catch { /* Native speech events are only available in the Android app. */ }
  render();
  await refreshAll(false);
}

start();
setInterval(() => refreshAll(false), 15 * 60 * 1000);
