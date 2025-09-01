const API_BASE = location.origin; // origin points to backend when using app.send_static_file
const downloadsList = document.getElementById("downloadsList");
const startBtn = document.getElementById("startBtn");

startBtn.addEventListener("click", async () => {
  const text = document.getElementById("links").value.trim();
  if (!text) { alert("Paste at least one YouTube link."); return; }

  // split lines, filter empty
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) { alert("No valid links found."); return; }

  // concurrency from select (this will be advisory; actual concurrency configured server-side)
  const concurrency = parseInt(document.getElementById("concurrency").value || "2", 10);

  // POST to /api/downloads
  const payload = { links: lines, concurrency };
  startBtn.disabled = true;
  startBtn.textContent = "Starting...";

  try {
    const resp = await fetch(`${API_BASE}/api/downloads`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ links: lines })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(()=>({error:"Failed"}));
      alert("Error: " + (err.error || resp.statusText));
      startBtn.disabled = false;
      startBtn.textContent = "Start Downloads";
      return;
    }
    const data = await resp.json();
    const tasks = data.tasks || {};

    // for each task create UI card and start polling progress
    Object.keys(tasks).forEach(taskId => {
      createDownloadCard(taskId, tasks[taskId].url);
      pollProgress(taskId);
    });

    // clear input
    document.getElementById("links").value = "";
  } catch (e) {
    alert("Network error: " + e.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start Downloads";
  }
});

function createDownloadCard(taskId, url) {
  const card = document.createElement("div");
  card.className = "dl-card";
  card.id = `card-${taskId}`;
  card.innerHTML = `
    <div class="dl-url">${escapeHtml(url)}</div>
    <div class="dl-meta">
      <div style="flex:1; margin-right:12px">
        <div class="progress-wrap"><div id="bar-${taskId}" class="progress-bar"></div></div>
        <div id="status-${taskId}" class="small">Queued</div>
      </div>
      <div id="action-${taskId}" style="min-width:120px; text-align:right"></div>
    </div>
  `;
  downloadsList.prepend(card);
}

async function pollProgress(taskId) {
  const statusEl = document.getElementById(`status-${taskId}`);
  const barEl = document.getElementById(`bar-${taskId}`);
  const actionEl = document.getElementById(`action-${taskId}`);

  const interval = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/progress/${taskId}`);
      if (!res.ok) {
        throw new Error(res.statusText);
      }
      const data = await res.json();
      const pct = Number((data.progress || 0).toString().replace("%","")) || 0;
      barEl.style.width = pct + "%";
      statusEl.textContent = `${data.status || "unknown"} — ${pct}%`;

      if (data.status === "finished" && data.filename) {
        clearInterval(interval);
        statusEl.textContent = "Finished — 100%";
        actionEl.innerHTML = `<a class="download-link" href="/downloads/${encodeURIComponent(data.filename)}" download>⬇ Download</a>`;
        barEl.style.width = "100%";
      } else if (data.status && (data.status + "").startsWith("error")) {
        clearInterval(interval);
        statusEl.textContent = data.status;
        actionEl.innerHTML = `<span style="color:#ff6b6b">Error</span>`;
      }
    } catch (err) {
      // network issue or server error — keep trying
      console.error("Polling error:", err);
    }
  }, 1400);
}

// simple text escape
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
