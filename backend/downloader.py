import os
import yt_dlp
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

# Where MP3s are saved
BASE_DIR = os.path.dirname(__file__)
DOWNLOADS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "downloads"))
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

# Progress storage: {task_id: {"status": str, "progress": int, "filename": str (when done)}}
progress_data = {}
_progress_lock = Lock()

# Configure concurrency
MAX_WORKERS = 3   # set how many downloads run in parallel (adjust for your machine)

_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

def _safe_update(task_id, info):
    with _progress_lock:
        if task_id not in progress_data:
            progress_data[task_id] = {}
        progress_data[task_id].update(info)

def _progress_hook_factory(task_id):
    # returns a hook to pass into ydl_opts
    def hook(d):
        # d contains status: 'downloading', 'finished', etc.
        if d.get("status") == "downloading":
            # prefer exact bytes if available
            percent_str = d.get("_percent_str") or d.get("percent")
            try:
                pct = int(float(str(percent_str).strip().replace("%", "")))
            except Exception:
                pct = 0
            _safe_update(task_id, {"status": "downloading", "progress": pct})
        elif d.get("status") == "finished":
            # processing stage (ffmpeg extracting)
            _safe_update(task_id, {"status": "processing", "progress": 100})
        # ignore other events
    return hook

def _download_worker(url, task_id):
    # wrapper that runs inside thread
    _safe_update(task_id, {"status": "starting", "progress": 0})
    hook = _progress_hook_factory(task_id)

    # output template: use title with extension (intermediate), final will become .mp3
    outtmpl = os.path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "noplaylist": True,
        "progress_hooks": [hook],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        # quiet because we rely on progress hooks
        "quiet": True,
        "no_warnings": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            # Determine final filename
            # ydl.prepare_filename(info) gives name with original ext, replace with .mp3
            try:
                base = ydl.prepare_filename(info)
                filename = os.path.splitext(os.path.basename(base))[0] + ".mp3"
            except Exception:
                # fallback to a generated name
                filename = f"{task_id}.mp3"

            _safe_update(task_id, {"status": "finished", "progress": 100, "filename": filename})
            return {"success": True, "filename": filename}
    except Exception as e:
        _safe_update(task_id, {"status": f"error: {str(e)}", "progress": 0})
        return {"success": False, "error": str(e)}

def submit_download(url):
    """
    Submits download to executor and returns task_id immediately.
    """
    task_id = str(uuid.uuid4())
    with _progress_lock:
        progress_data[task_id] = {"status": "queued", "progress": 0}
    # schedule worker
    _executor.submit(_download_worker, url, task_id)
    return task_id

def get_progress(task_id):
    with _progress_lock:
        return progress_data.get(task_id, {"status": "unknown", "progress": 0})

def get_all_progress():
    with _progress_lock:
        return dict(progress_data)
