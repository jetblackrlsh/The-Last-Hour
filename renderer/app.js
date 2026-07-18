const state = {
  subjectGroups: [],
  topics: [],
  feeds: {},
  mode: "topic",
  groupIndex: 0,
  topic: "Grok AI",
  hours: 24,
  selectedTopics: new Set(),
  loadingTopics: new Set(),
  failedTopics: new Set(),
  summaries: new Map(),
  visibleCount: 20,
  lastRenderFeed: null,
  appInfo: null,
  updating: false
};

let activeSpeech = null;

const elements = Object.fromEntries([
  "subjectNav", "topicRail", "filterDrawer", "filterGroups", "filterCount", "modeKicker",
  "viewTitle", "windowToggle", "signalLabel", "signalDescription", "storyCount", "topicCount",
  "lastSync", "dataMode", "storySurface", "streamSentinel", "refreshButton", "filterButton",
  "exportButton", "aboutButton", "aboutDialog", "aboutClose", "exportDialog", "exportClose",
  "selectAll", "clearAll", "statusDot", "localStatus", "cacheSummary", "progressBar", "brandButton",
  "appVersion", "updateStatus", "updateProgress", "updateButton",
  "weatherWidget", "weatherRefresh", "huntsvilleClock", "weatherTemperature", "weatherCondition", "weatherFreshness"
].map((id) => [id, document.getElementById(id)]));

const huntsvilleTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true
});
const huntsvilleDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "2-digit",
  day: "2-digit",
  year: "numeric"
});

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitHeadline(fullTitle) {
  const divider = fullTitle.lastIndexOf(" - ");
  if (divider < 1) return { title: fullTitle, source: "Google News" };
  return {
    title: fullTitle.slice(0, divider).trim(),
    source: fullTitle.slice(divider + 3).trim() || "Google News"
  };
}

function stableId(url) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `story-${(hash >>> 0).toString(16)}`;
}

function timeAgo(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "NOW";
  if (minutes >= 60) return `${Math.floor(minutes / 60)}H AGO`;
  return `${minutes}M AGO`;
}

function clockTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function updateHuntsvilleClock() {
  const now = new Date();
  elements.huntsvilleClock.textContent = `${huntsvilleTimeFormatter.format(now)} ${huntsvilleDateFormatter.format(now)}`;
  elements.huntsvilleClock.dateTime = now.toISOString();
}

async function refreshWeather(force = false) {
  elements.weatherRefresh.classList.add("loading");
  try {
    const weather = await window.lastHour.currentWeather(force);
    elements.weatherTemperature.textContent = `${weather.temperature}${weather.temperatureUnit}`;
    elements.weatherCondition.textContent = weather.condition;
    elements.weatherWidget.dataset.weatherTone = weather.tone;
    elements.weatherWidget.classList.remove("updated");
    requestAnimationFrame(() => elements.weatherWidget.classList.add("updated"));
    const freshLabel = weather.stale ? "SAVED CONDITIONS" : "CURRENT CONDITIONS";
    elements.weatherFreshness.textContent = `OPEN-METEO · ${freshLabel}`;
  } catch (error) {
    elements.weatherCondition.textContent = "Weather unavailable";
    elements.weatherFreshness.textContent = "OPEN-METEO · RETRY WHEN ONLINE";
    elements.weatherWidget.dataset.weatherTone = "unknown";
  } finally {
    elements.weatherRefresh.classList.remove("loading");
  }
}

function activeTopics() {
  if (state.mode === "topic") return [state.topic];
  return [...state.selectedTopics];
}

function buildStories() {
  const cutoff = Date.now() - state.hours * 60 * 60 * 1000;
  const allowed = new Set(activeTopics());
  return Object.values(state.feeds)
    .filter((feed) => allowed.has(feed.topic))
    .flatMap((feed) => (feed.items || []).map((item) => ({ ...item, topic: feed.topic, fetchedAt: feed.fetchedAt })))
    .map((item) => {
      const headline = splitHeadline(item.title || "");
      return {
        id: stableId(item.link || ""),
        title: headline.title,
        source: headline.source,
        url: item.link || "",
        publishedAt: new Date(item.pubDate || 0).toISOString(),
        fetchedAt: item.fetchedAt,
        topic: item.topic
      };
    })
    .filter((story) => story.title && story.url && new Date(story.publishedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .filter((story, index, list) => list.findIndex((candidate) => candidate.url === story.url) === index);
}

function latestSync(topics) {
  return topics
    .map((topic) => state.feeds[topic]?.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function googleNewsUrl() {
  const topics = activeTopics();
  const query = topics.length === 1 ? topics[0] : topics.map((topic) => `(${topic})`).join(" OR ");
  const params = new URLSearchParams({ q: `${query} when:${state.hours === 1 ? "1h" : "1d"}`, hl: "en-US", gl: "US", ceid: "US:en" });
  return `https://news.google.com/search?${params.toString()}`;
}

function renderNavigation() {
  elements.subjectNav.innerHTML = state.subjectGroups.map((group, index) => `
    <button class="subject-button ${index === state.groupIndex ? "active" : ""}" data-group="${index}">
      <span>${escapeHtml(group.code)}</span><strong>${escapeHtml(group.name)}</strong><small>${group.topics.length}</small>
    </button>`).join("");

  const topics = state.subjectGroups[state.groupIndex]?.topics || [];
  elements.topicRail.hidden = state.mode !== "topic";
  elements.topicRail.innerHTML = topics.map((topic) => `
    <button class="topic-chip ${topic === state.topic ? "active" : ""}" data-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("");

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
}

function renderFilters() {
  elements.filterCount.textContent = state.selectedTopics.size;
  elements.filterGroups.innerHTML = state.subjectGroups.map((group) => `
    <div class="filter-group"><h3>${escapeHtml(group.code)} · ${escapeHtml(group.name)}</h3><div>
      ${group.topics.map((topic) => `<button class="filter-topic ${state.selectedTopics.has(topic) ? "active" : ""}" data-filter-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("")}
    </div></div>`).join("");
}

function renderStatus() {
  const cachedCount = Object.values(state.feeds).filter((feed) => Array.isArray(feed.items)).length;
  const completed = cachedCount + state.failedTopics.size;
  const isLoading = state.loadingTopics.size > 0;
  elements.statusDot.className = `status-dot${isLoading ? " loading" : state.failedTopics.size && !cachedCount ? " error" : ""}`;
  elements.localStatus.textContent = isLoading ? `SCANNING ${state.loadingTopics.size} SIGNALS` : "LOCAL CACHE READY";
  elements.cacheSummary.textContent = `${cachedCount} of ${state.topics.length} topics saved on this computer${state.failedTopics.size ? ` · ${state.failedTopics.size} refresh failures` : ""}`;
  elements.progressBar.style.width = `${Math.min(100, (completed / Math.max(1, state.topics.length)) * 100)}%`;
  elements.refreshButton.classList.toggle("loading", isLoading);
}

function summaryMarkup(story) {
  const item = state.summaries.get(story.id);
  const isExpanded = Boolean(item && item.expanded);
  const isSpeaking = activeSpeech?.storyId === story.id;
  const label = item?.status === "loading"
    ? "SUMMARIZING…"
    : item?.status === "ready"
      ? isExpanded ? "HIDE SUMMARY" : "SHOW SUMMARY"
      : item?.status === "error" ? "RETRY SUMMARY" : "SUMMARIZE";
  const button = `<button class="summarize-button ${item?.status || ""}" data-summarize="${escapeHtml(story.id)}" aria-controls="summary-${escapeHtml(story.id)}" aria-expanded="${isExpanded}" ${item?.status === "loading" ? "disabled" : ""}><span>✦</span>${label}</button>`;

  if (!item || !isExpanded) return { button, panel: "" };
  const content = item.status === "loading"
    ? `<div class="summary-loading"><i></i><span>Codex is reading and checking this signal…</span></div>`
    : item.status === "error"
      ? `<p class="summary-error">${escapeHtml(item.error)}</p>`
      : `<div class="summary-content"><p>${escapeHtml(item.text)}</p><div class="summary-audio"><button class="read-aloud-button${isSpeaking ? " speaking" : ""}" data-read-aloud="${escapeHtml(story.id)}" aria-pressed="${isSpeaking}" ${"speechSynthesis" in window && "SpeechSynthesisUtterance" in window ? "" : "disabled"}><span>${isSpeaking ? "■" : "▶"}</span>${isSpeaking ? "STOP READING" : "READ ALOUD"}</button><small>USES YOUR SYSTEM VOICE</small></div></div>`;
  return {
    button,
    panel: `<section class="story-summary ${item.status}" id="summary-${escapeHtml(story.id)}" aria-live="polite"><div class="summary-label"><span>CODEX BRIEF</span><small>AI-GENERATED · VERIFY IMPORTANT DETAILS</small></div>${content}</section>`
  };
}

function storyEntry(story, index, isLead = false) {
  const summary = summaryMarkup(story);
  if (isLead) {
    return `<div class="story-entry lead-entry">
      <article class="lead-story" data-url="${escapeHtml(story.url)}">
        <div class="story-meta"><span>${escapeHtml(story.topic)}</span><span>${escapeHtml(story.source)} · ${timeAgo(story.publishedAt)}</span></div>
        <h2>${escapeHtml(story.title)}</h2>
        <div class="story-actions">${summary.button}<button class="open-signal" data-open-url="${escapeHtml(story.url)}">OPEN SIGNAL ↗</button></div>
      </article>${summary.panel}
    </div>`;
  }

  return `<div class="story-entry row-entry">
    <article class="story-row" data-url="${escapeHtml(story.url)}">
      <span class="story-index">${String(index).padStart(3, "0")}</span>
      <div class="story-copy"><div class="story-meta"><span>${escapeHtml(story.topic)}</span><span>${escapeHtml(story.source)} · ${timeAgo(story.publishedAt)}</span></div><h3>${escapeHtml(story.title)}</h3></div>
      ${summary.button}<button class="story-arrow" data-open-url="${escapeHtml(story.url)}" aria-label="Open ${escapeHtml(story.title)}">↗</button>
    </article>${summary.panel}
  </div>`;
}

function renderStories() {
  const stories = buildStories();
  const topics = activeTopics();
  const sync = latestSync(topics);
  const liveTopics = topics.filter((topic) => state.feeds[topic]?.fetchedAt);
  const failedActive = topics.filter((topic) => state.failedTopics.has(topic));
  const availableTopics = new Set(stories.map((story) => story.topic));

  const titles = {
    topic: state.topic,
    ultra: "Ultra Feed",
    super: "Super Feed"
  };
  const kickers = {
    topic: "F01 · FOCUSED SIGNAL",
    ultra: "U02 · COMBINED OBSERVATORY",
    super: "S03 · CONTINUOUS 24-HOUR SIGNAL"
  };
  elements.viewTitle.textContent = titles[state.mode];
  elements.modeKicker.textContent = kickers[state.mode];
  elements.signalLabel.textContent = state.hours === 1 ? "LATEST ONE-HOUR SIGNALS" : "LATEST 24-HOUR SIGNALS";
  elements.signalDescription.textContent = failedActive.length
    ? `${failedActive.length} topic refresh${failedActive.length === 1 ? "" : "es"} failed; saved stories remain visible.`
    : "Direct from Google News, fetched and stored on this computer.";
  elements.storyCount.textContent = stories.length;
  elements.topicCount.textContent = availableTopics.size;
  elements.lastSync.textContent = clockTime(sync);
  elements.dataMode.textContent = failedActive.length ? "LIVE + SAVED" : liveTopics.length ? "LOCAL LIVE" : "NO CACHE";
  elements.windowToggle.hidden = state.mode === "super";
  document.querySelectorAll("[data-hours]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.hours) === state.hours);
  });
  document.body.classList.toggle("super-mode", state.mode === "super");

  if (!stories.length) {
    elements.storySurface.innerHTML = `<div class="empty-state"><div><strong>No signals in this window.</strong><span>${state.loadingTopics.size ? "A local refresh is still in progress." : "Try the 24-hour window or refresh this feed."}</span></div></div>`;
    elements.streamSentinel.hidden = true;
  } else {
    const count = state.mode === "super" ? state.visibleCount : stories.length;
    const visible = stories.slice(0, count);
    const lead = visible[0];
    const rows = state.mode === "super" ? visible : visible.slice(1);
    elements.storySurface.innerHTML = `
      ${state.mode === "super" ? "" : storyEntry(lead, 1, true)}
      <div class="story-list">${rows.map((story, index) => storyEntry(story, index + (state.mode === "super" ? 1 : 2))).join("")}</div>`;
    elements.streamSentinel.hidden = state.mode !== "super";
    elements.streamSentinel.textContent = state.visibleCount < stories.length ? "SCROLL FOR MORE SIGNALS" : "END OF CURRENT 24-HOUR WINDOW";
  }

  state.lastRenderFeed = {
    version: "1.0",
    mode: state.mode,
    window: `${state.hours}h`,
    generatedAt: new Date().toISOString(),
    topicCount: availableTopics.size,
    storyCount: stories.length,
    items: stories
  };
  renderStatus();
}

async function updateToLatest() {
  if (state.updating) return;
  state.updating = true;
  elements.updateButton.disabled = true;
  elements.updateProgress.style.width = "3%";
  elements.updateStatus.textContent = "Checking the latest GitHub release…";
  try {
    const result = await window.lastHour.installUpdate();
    if (!result.available) {
      elements.updateStatus.textContent = `Version ${result.currentVersion} is already the latest release.`;
      elements.updateProgress.style.width = "100%";
      state.updating = false;
      elements.updateButton.disabled = false;
      elements.updateButton.textContent = "CHECK AGAIN";
    } else if (result.installing) {
      elements.updateStatus.textContent = `Installing version ${result.latestVersion}; The Last Hour will restart automatically.`;
    }
  } catch (error) {
    elements.updateStatus.textContent = error.message || "The update could not be installed.";
    elements.updateProgress.style.width = "0%";
    state.updating = false;
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = "TRY UPDATE AGAIN";
  }
}

function render() {
  renderNavigation();
  renderFilters();
  renderStories();
}

async function refreshCurrent(force = true) {
  state.failedTopics.clear();
  if (state.mode === "topic") {
    state.loadingTopics.add(state.topic);
    renderStatus();
    const result = await window.lastHour.refreshTopic(state.topic, { force });
    if (result.feed) state.feeds[state.topic] = result.feed;
    state.loadingTopics.delete(state.topic);
    if (!result.ok) state.failedTopics.add(state.topic);
    render();
    return;
  }
  state.loadingTopics = new Set(state.topics);
  renderStatus();
  const result = await window.lastHour.refreshAll({ force });
  state.feeds = result.feeds;
  state.loadingTopics.clear();
  for (const item of result.results || []) if (!item.ok) state.failedTopics.add(item.topic);
  render();
}

function setMode(mode) {
  stopReading();
  state.mode = mode;
  state.hours = mode === "super" ? 24 : state.hours;
  state.visibleCount = 20;
  elements.filterDrawer.hidden = true;
  render();
}

function stopReading(storyId = null, rerender = true) {
  if (!activeSpeech || (storyId && activeSpeech.storyId !== storyId)) return;
  activeSpeech.utterance.onend = null;
  activeSpeech.utterance.onerror = null;
  window.speechSynthesis.cancel();
  activeSpeech = null;
  if (rerender) renderStories();
}

function readSummary(storyId) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  if (activeSpeech?.storyId === storyId) {
    stopReading(storyId);
    return;
  }

  const summary = state.summaries.get(storyId);
  if (summary?.status !== "ready" || !summary.text) return;
  stopReading(null, false);

  const utterance = new SpeechSynthesisUtterance(summary.text);
  utterance.lang = "en-US";
  utterance.rate = 0.95;
  utterance.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.default && voice.lang?.toLowerCase().startsWith("en"))
    || voices.find((voice) => voice.lang?.toLowerCase().startsWith("en-us"))
    || voices.find((voice) => voice.lang?.toLowerCase().startsWith("en"))
    || null;

  const finish = () => {
    if (activeSpeech?.utterance !== utterance) return;
    activeSpeech = null;
    renderStories();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  activeSpeech = { storyId, utterance };
  window.speechSynthesis.speak(utterance);
  renderStories();
}

async function summarizeStory(storyId) {
  const existing = state.summaries.get(storyId);
  if (existing?.status === "loading") return;
  if (existing?.status === "ready") {
    if (existing.expanded) stopReading(storyId, false);
    existing.expanded = !existing.expanded;
    renderStories();
    return;
  }

  const story = buildStories().find((item) => item.id === storyId);
  if (!story) return;
  state.summaries.set(storyId, { status: "loading", expanded: true });
  renderStories();
  const result = await window.lastHour.summarizeStory(story);
  state.summaries.set(storyId, result.ok
    ? { status: "ready", expanded: true, text: result.summary }
    : { status: "error", expanded: true, error: result.error || "Codex could not create a summary." });
  renderStories();
}

document.addEventListener("click", (event) => {
  const readAloudButton = event.target.closest("[data-read-aloud]");
  if (readAloudButton) {
    event.stopPropagation();
    return readSummary(readAloudButton.dataset.readAloud);
  }
  const summaryButton = event.target.closest("[data-summarize]");
  if (summaryButton) {
    event.stopPropagation();
    return summarizeStory(summaryButton.dataset.summarize);
  }
  const openButton = event.target.closest("[data-open-url]");
  if (openButton) {
    event.stopPropagation();
    return window.lastHour.openExternal(openButton.dataset.openUrl);
  }
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) return setMode(modeButton.dataset.mode);
  const groupButton = event.target.closest("[data-group]");
  if (groupButton) {
    stopReading();
    state.groupIndex = Number(groupButton.dataset.group);
    if (state.mode === "topic") {
      state.topic = state.subjectGroups[state.groupIndex].topics[0];
      render();
      return refreshCurrent(false);
    }
    return render();
  }
  const topicButton = event.target.closest("[data-topic]");
  if (topicButton) {
    stopReading();
    state.topic = topicButton.dataset.topic;
    state.mode = "topic";
    state.visibleCount = 20;
    render();
    return refreshCurrent(false);
  }
  const filterTopic = event.target.closest("[data-filter-topic]");
  if (filterTopic) {
    stopReading();
    const topic = filterTopic.dataset.filterTopic;
    if (state.selectedTopics.has(topic)) state.selectedTopics.delete(topic); else state.selectedTopics.add(topic);
    render();
    return;
  }
  const hoursButton = event.target.closest("[data-hours]");
  if (hoursButton) {
    stopReading();
    state.hours = Number(hoursButton.dataset.hours);
    document.querySelectorAll("[data-hours]").forEach((button) => button.classList.toggle("active", button === hoursButton));
    renderStories();
    return;
  }
  const story = event.target.closest("[data-url]");
  if (story) window.lastHour.openExternal(story.dataset.url);
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-url]")) {
    event.preventDefault();
    window.lastHour.openExternal(event.target.dataset.url);
  }
});

elements.refreshButton.addEventListener("click", () => refreshCurrent(true));
elements.filterButton.addEventListener("click", () => { elements.filterDrawer.hidden = !elements.filterDrawer.hidden; });
elements.selectAll.addEventListener("click", () => { state.selectedTopics = new Set(state.topics); render(); });
elements.clearAll.addEventListener("click", () => { state.selectedTopics.clear(); render(); });
elements.aboutButton.addEventListener("click", () => elements.aboutDialog.showModal());
elements.aboutClose.addEventListener("click", () => elements.aboutDialog.close());
elements.exportButton.addEventListener("click", () => elements.exportDialog.showModal());
elements.exportClose.addEventListener("click", () => elements.exportDialog.close());
elements.brandButton.addEventListener("click", () => setMode("topic"));
elements.updateButton.addEventListener("click", updateToLatest);
elements.weatherRefresh.addEventListener("click", () => refreshWeather(true));
window.addEventListener("beforeunload", () => stopReading(null, false));

document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", async () => {
  if (state.lastRenderFeed) await window.lastHour.exportFeed(button.dataset.export, state.lastRenderFeed);
  elements.exportDialog.close();
}));

const observer = new IntersectionObserver((entries) => {
  if (entries[0]?.isIntersecting && state.mode === "super") {
    state.visibleCount += 20;
    renderStories();
  }
}, { root: document.querySelector(".workspace"), rootMargin: "400px" });
observer.observe(elements.streamSentinel);

window.lastHour.onProgress((progress) => {
  if (progress.state === "loading") state.loadingTopics.add(progress.topic);
  if (progress.state === "complete" || progress.state === "failed") state.loadingTopics.delete(progress.topic);
  if (progress.state === "complete" && progress.result?.feed) {
    state.feeds[progress.topic] = progress.result.feed;
    state.failedTopics.delete(progress.topic);
  }
  if (progress.state === "failed") state.failedTopics.add(progress.topic);
  renderStories();
});

window.lastHour.onUpdateProgress((progress) => {
  const messages = {
    starting: `Preparing version ${progress.latestVersion || ""}…`,
    downloading: `Downloading update${progress.percent ? ` · ${progress.percent}%` : ""}…`,
    verifying: "Verifying the release checksum…",
    preparing: "Preparing the new application…",
    installing: "Installing and restarting The Last Hour…"
  };
  elements.updateStatus.textContent = messages[progress.phase] || "Updating The Last Hour…";
  const percent = progress.phase === "starting"
    ? 3
    : Number.isFinite(progress.percent) ? progress.percent : 100;
  elements.updateProgress.style.width = `${percent}%`;
});

async function start() {
  updateHuntsvilleClock();
  refreshWeather(false);
  const [snapshot, appInfo] = await Promise.all([window.lastHour.snapshot(), window.lastHour.appInfo()]);
  state.appInfo = appInfo;
  elements.appVersion.textContent = appInfo.version;
  state.subjectGroups = snapshot.subjectGroups;
  state.topics = snapshot.topics;
  state.feeds = snapshot.feeds;
  state.selectedTopics = new Set(snapshot.topics);
  render();
  state.loadingTopics = new Set(snapshot.topics);
  renderStatus();
  const result = await window.lastHour.refreshAll({ force: false });
  state.feeds = result.feeds;
  state.loadingTopics.clear();
  state.failedTopics = new Set((result.results || []).filter((item) => !item.ok).map((item) => item.topic));
  render();
}

start();
setInterval(updateHuntsvilleClock, 1000);
setInterval(() => refreshWeather(false), 15 * 60 * 1000);
setInterval(() => refreshCurrent(false), 15 * 60 * 1000);
