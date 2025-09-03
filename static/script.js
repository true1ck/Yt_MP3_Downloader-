document.addEventListener("DOMContentLoaded", () => {
    // ====== Config ======
    const POLL_INTERVAL_MS = 1000; // Poll more frequently for smoother updates

    // ====== Utilities ======
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

    const sanitizeLinks = (raw) => {
      return raw.split(/\n|,/g).map(s => s.trim()).filter(Boolean).filter(isMaybeYouTubeUrl);
    };

    function isMaybeYouTubeUrl(u) {
      try {
        const url = new URL(u);
        return /(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === "youtu.be";
      } catch { return false; }
    }

    function extractVideoId(url) {
      try {
          const u = new URL(url);
          if (u.hostname === "youtu.be") return u.pathname.substring(1).split('/')[0];
          if (u.hostname.endsWith("youtube.com")) {
              if (u.searchParams.get("v")) return u.searchParams.get("v");
              const parts = u.pathname.split("/");
              const shortsIdx = parts.indexOf("shorts");
              if (shortsIdx !== -1 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
              const embedIdx = parts.indexOf("embed");
              if (embedIdx !== -1 && parts[embedIdx + 1]) return parts[embedIdx + 1];
          }
      } catch {}
      return null;
    }

    function thumbFor(url) {
      const id = extractVideoId(url);
      return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "";
    }

    async function titleFromOEmbed(url) {
        try {
            const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            if (!res.ok) return null;
            const data = await res.json();
            return data.title || null;
        } catch { return null; }
    }

    // ====== State ======
    const queue = []; // { id, url, title, status, progress, filename, speed, eta }
    const historyKey = "ytmp3_history_v1";

    function saveHistory(item) {
      const old = JSON.parse(localStorage.getItem(historyKey) || "[]");
      if (old.some(entry => entry.filename === item.filename)) return;
      const fresh = [{ title: item.title || item.url, filename: item.filename, ts: Date.now() }, ...old].slice(0, 10);
      localStorage.setItem(historyKey, JSON.stringify(fresh));
      renderHistory();
    }

    function renderHistory() {
      const list = JSON.parse(localStorage.getItem(historyKey) || "[]");
      const wrap = $("#historyList");
      const clearBtn = $("#clearHistory");
      if (list.length === 0) {
        wrap.innerHTML = `<div class="text-muted p-2">No download history.</div>`;
        clearBtn.classList.add('d-none');
        return;
      }
      clearBtn.classList.remove('d-none');
      wrap.innerHTML = list.map(entry => {
        const date = new Date(entry.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        return `<div class="history-item">
            <div class="text-truncate me-2" title="${entry.title}">
              <i class="bi bi-music-note-beamed me-1"></i>${entry.title}
              <div class="text-muted small">${date}</div>
            </div>
            <a href="/download/${encodeURIComponent(entry.filename)}" class="btn btn-sm btn-outline-primary flex-shrink-0"><i class="bi bi-download"></i><span class="d-none d-sm-inline ms-1">Download</span></a>
          </div>`;
      }).join("");
    }

    // ====== Rendering ======
    function renderQueue() {
      const list = $("#queueList");
      const empty = $("#emptyQueue");
      if (queue.length === 0) {
        empty.classList.remove("d-none");
        list.innerHTML = "";
        return;
      }
      empty.classList.add("d-none");

      // ensure order stable
      list.innerHTML = "";
      queue.forEach(item => {
        let el = document.createElement("div");
        el.dataset.id = item.id;
        el.className = `queue-item ${(item.status === "Downloading" || item.status === "Converting") ? "current" : ""}`;

        const downloadButton = item.filename ? `<a class="btn btn-sm btn-success ms-auto" href="/download/${encodeURIComponent(item.filename)}"><i class="bi bi-download"></i> Download</a>` : "";
        const progressDetails = (item.status === 'Downloading') ? `
          <div class="progress-details">
            <span>${item.percent || 0}%</span>
            <span class="text-muted">${item.speed || '...'}</span>
            <span class="text-muted">ETA: ${item.eta || '...'}</span>
          </div>` : '';

        el.innerHTML = `
            <div class="queue-thumb" aria-hidden="true">
              <img src="${thumbFor(item.url)}" alt="Video thumbnail" loading="lazy">
            </div>
            <div class="flex-grow-1">
              <p class="queue-title text-truncate mb-1" title="${item.title || item.url}">${item.title || "Loading title..."}</p>
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="status-badge status-${item.status}">${item.status}</span>
                <span class="queue-meta small">${item.status === "Failed" ? item.message : ''}</span>
                ${downloadButton}
              </div>
              ${ (item.status === 'Downloading' || item.status === 'Converting') ? `
              <div class="mt-2">
                <div class="progress" role="progressbar" aria-valuenow="${item.percent||0}" aria-valuemin="0" aria-valuemax="100">
                  <div class="progress-bar progress-bar-striped progress-bar-animated" style="width:${item.percent||0}%"></div>
                </div>
                ${progressDetails}
              </div>` : ''}
            </div>
            <div class="d-flex flex-column gap-1 ms-2">
              ${item.status === "Failed" ? `<button class="btn btn-sm btn-outline-primary" data-action="retry" title="Retry"><i class="bi bi-arrow-clockwise"></i></button>` : ""}
            </div>
        `;
        list.appendChild(el);
      });
    }

    function handleQueueClick(ev) {
      const btn = ev.target.closest("[data-action]");
      if (!btn) return;
      const itemEl = btn.closest(".queue-item");
      if (!itemEl) return;
      const item = queue.find(i => i.id === itemEl.dataset.id);
      if (item && btn.dataset.action === "retry") retryItem(item);
    }

    function upsertQueueItemByUrl(url, patch) {
      const item = queue.find(q => q.url === url);
      if (item) Object.assign(item, patch);
    }

    async function retryItem(item) {
      const idx = queue.findIndex(i => i.id === item.id);
      if (idx !== -1) queue.splice(idx, 1);
      renderQueue();
      await submitLinks([item.url], false);
    }

    // ====== Submit + Polling ======
    let pollTimer = null;
    let isPolling = false;

    async function submitLinks(links, showErrors = true) {
      if (links.length === 0) {
        if (showErrors) setError("Please paste at least one valid YouTube link.");
        return;
      }

      let addedCount = 0;
      for (const url of links) {
        if (queue.some(q => q.url === url)) continue;
        addedCount++;
        const newItem = { id: crypto.randomUUID(), url, status: "Queued" };
        queue.push(newItem);
        titleFromOEmbed(url).then(title => {
          if(title) {
            upsertQueueItemByUrl(url, { title });
            renderQueue();
          }
        });
      }

      if (addedCount > 0) {
          renderQueue();
          setError("");
          $("#links").value = "";
      } else {
          if (showErrors) setError("These links are already in the queue.");
          return;
      }

      const fd = new FormData();
      fd.append("links", links.join("\n"));
      try {
        await fetch("/start_download", { method: "POST", body: fd });
      } catch (e) {
        setError("Server error: failed to start download process.");
        return;
      }

      if (!isPolling) {
        isPolling = true;
        pollProgress();
        pollTimer = setInterval(pollProgress, POLL_INTERVAL_MS);
      }
    }

    async function pollProgress() {
      const hasActiveItems = queue.some(q => ["Queued", "Downloading", "Converting"].includes(q.status));
      if (!hasActiveItems) {
        clearInterval(pollTimer);
        isPolling = false;
        return;
      }

      try {
        const res = await fetch("/progress");
        if (!res.ok) return;
        const msgs = await res.json();
        if (Array.isArray(msgs)) handleProgressMessages(msgs);
      } catch (e) {
        // ignore transient network issues
      }
    }

    function handleProgressMessages(messages) {
      if (messages.length === 0) return;

      messages.forEach(msg => {
          switch(msg.type) {
              case 'status':
                  upsertQueueItemByUrl(msg.url, { status: msg.status });
                  break;
              case 'progress':
                  upsertQueueItemByUrl(msg.url, {
                      status: 'Downloading',
                      percent: msg.percent,
                      speed: msg.speed,
                      eta: msg.eta
                  });
                  break;
              case 'done':
                  {
                    const item = queue.find(q => q.url === msg.url);
                    if (item) {
                        Object.assign(item, { status: "Completed", filename: msg.filename, percent: 100 });
                        saveHistory(item);
                    }
                  }
                  break;
              case 'error':
                  upsertQueueItemByUrl(msg.url, { status: "Failed", message: msg.message });
                  setError(msg.message);
                  break;
              case 'all_done':
                  // stop polling immediately
                  clearInterval(pollTimer);
                  isPolling = false;
                  break;
          }
      });
      renderQueue();
    }

    // ====== Event Listeners ======
    function setError(msg) {
      const box = $("#errorBox");
      box.textContent = msg;
      box.classList.toggle("d-none", !msg);
    }

    $("#downloadForm").addEventListener("submit", async e => {
      e.preventDefault();
      await submitLinks(sanitizeLinks($("#links").value));
    });

    $("#queueList").addEventListener("click", handleQueueClick);

    $("#clearHistory").addEventListener("click", () => {
      localStorage.removeItem(historyKey);
      renderHistory();
    });

    $("#clearQueued").addEventListener("click", () => {
      queue.length = 0;
      renderQueue();
    });

    const dz = $("#dropzone");
    const preventDefaults = e => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, preventDefaults));
    ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, () => dz.classList.add("dragover")));
    ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, () => dz.classList.remove("dragover")));

    dz.addEventListener("drop", async e => {
        const text = e.dataTransfer.getData("text/plain");
        await submitLinks(sanitizeLinks(text));
    });
    dz.addEventListener("click", () => $("#links").focus());

    const rootEl = document.documentElement;
    $("#themeToggle").addEventListener("click", () => {
        const newTheme = (rootEl.getAttribute("data-bs-theme") || "light") === "light" ? "dark" : "light";
        rootEl.setAttribute("data-bs-theme", newTheme);
        localStorage.setItem("theme", newTheme);
    });

    // Init
    rootEl.setAttribute("data-bs-theme", localStorage.getItem("theme") || "light");
    $("#year").textContent = new Date().getFullYear();
    renderHistory();
  });
