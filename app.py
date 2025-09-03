from flask import Flask, render_template, request, jsonify, send_from_directory
import yt_dlp
import os
import uuid
import threading
import queue
import re
import shutil
import traceback
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__, static_folder="static", template_folder="templates")

DOWNLOAD_FOLDER = "downloads"
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

# Thread-safe queue to send structured status messages to the frontend
status_queue = queue.Queue()

# Detect ffmpeg/ffprobe location (either on PATH or from env FFMPEG_LOCATION)
def detect_ffmpeg_location():
    # check env var first
    env_loc = os.environ.get("FFMPEG_LOCATION")
    if env_loc:
        if os.path.exists(env_loc):
            return env_loc
    # look on PATH
    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    if ffmpeg_path and ffprobe_path:
        # prefer ffmpeg binary dir as ffmpeg_location
        return os.path.dirname(ffmpeg_path)
    # not found
    return None

FFMPEG_LOCATION = detect_ffmpeg_location()
ARIA2C_AVAILABLE = bool(shutil.which("aria2c"))

def make_progress_hook(url):
    """
    Create a progress hook closure bound to the original URL.
    This avoids relying on info_dict availability inside the hook.
    """
    def progress_hook(d):
        try:
            status = d.get("status")
            if status == "downloading":
                # percent may be in _percent_str or percent field — handle robustly
                # Accept strings like " 13.8%", "13%", or floats
                percent = 0.0
                pstr = d.get("_percent_str") or d.get("percent") or "0"
                try:
                    # remove non numeric characters except dot
                    cleaned = re.sub(r"[^0-9.]", "", str(pstr))
                    percent = float(cleaned) if cleaned else 0.0
                except Exception:
                    percent = 0.0

                speed = (d.get("_speed_str") or d.get("speed") or "").strip()
                eta = (d.get("_eta_str") or d.get("eta") or "").strip()

                status_queue.put({
                    "type": "progress",
                    "url": url,
                    "percent": round(percent, 2),
                    "speed": speed,
                    "eta": eta
                })
            elif status == "finished":
                # When postprocessing is about to start, yt-dlp emits 'finished' with filename
                filename = d.get("filename")
                # If filename ends not in .mp3, we assume conversion will start
                if filename and not filename.lower().endswith(".mp3"):
                    status_queue.put({
                        "type": "status",
                        "url": url,
                        "status": "Converting"
                    })
        except Exception as e:
            # ensure hook never raises
            status_queue.put({
                "type": "error",
                "url": url,
                "message": f"Progress hook error: {str(e)}"
            })
    return progress_hook

def sanitize_title_for_filename(s):
    if not s:
        return "yt_audio"
    # Replace illegal characters for filenames (Windows / Unix)
    return re.sub(r'[\\/*?:"<>|]', "_", s)

def download_audio(url):
    """Download YouTube video as MP3 and return the final file path (basename)."""
    unique_id = str(uuid.uuid4())[:8]
    # We'll sanitize the title later after we get info, but provide a fallback template
    out_template = os.path.join(DOWNLOAD_FOLDER, f"%(title)s_{unique_id}.%(ext)s")

    # Build ydl options dynamically
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        # don't predeclare progress hooks here; we'll attach a per-download hook
        "noplaylist": True,
        "continuedl": True,
        "quiet": True,
        "no_warnings": True,
    }

    # Use aria2c if available (optional)
    if ARIA2C_AVAILABLE:
        ydl_opts.update({
            "external_downloader": "aria2c",
            "external_downloader_args": ["-x16", "-s16", "-k1M"],
        })

    # If we detected ffmpeg location, tell yt-dlp about it (will help postprocessing)
    if FFMPEG_LOCATION:
        ydl_opts["ffmpeg_location"] = FFMPEG_LOCATION

    # Use a per-download progress hook (bind url)
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        # attach progress hook
        ydl.add_progress_hook(make_progress_hook(url))

        # Extract info & download (this will call the hook multiple times)
        info = ydl.extract_info(url, download=True)

        # Try to build the final filename path
        try:
            # prepare_filename may include non-sanitized title; sanitize
            filename_with_ext = ydl.prepare_filename(info)
            base_filename, _ = os.path.splitext(filename_with_ext)
            final_filename = base_filename + ".mp3"
            # Ensure we return the final file name (basename)
            return os.path.basename(final_filename)
        except Exception:
            # Fallback: create safe filename from title and unique id
            safe = sanitize_title_for_filename(info.get("title", "yt_audio"))
            final = f"{safe}_{unique_id}.mp3"
            return final

def download_audio_safe(link):
    link = link.strip()
    if not link:
        return
    try:
        status_queue.put({"type": "status", "url": link, "status": "Downloading"})
        filename = download_audio(link)

        # If ffmpeg was not found, yt-dlp would have raised earlier.
        # But still double-check existence of the file and notify client.
        if filename and os.path.exists(os.path.join(DOWNLOAD_FOLDER, filename)):
            status_queue.put({"type": "done", "url": link, "filename": filename})
        else:
            # Might have failed during postprocessing
            status_queue.put({"type": "error", "url": link, "message": "Download completed but postprocessing failed or output file missing. Ensure ffmpeg/ffprobe are installed."})
    except Exception as e:
        # Provide a clearer error if ffmpeg/ffprobe not found
        tb = traceback.format_exc()
        msg = str(e)
        if "ffprobe and ffmpeg not found" in msg or "ffmpeg" in tb.lower() and "not found" in tb.lower():
            msg = ("Postprocessing failed: ffprobe and ffmpeg not found. "
                   "Install ffmpeg (https://ffmpeg.org/) or set environment variable FFMPEG_LOCATION to the ffmpeg binary directory.")
        status_queue.put({"type": "error", "url": link, "message": msg})

def download_worker(links):
    # run downloads in parallel threads
    with ThreadPoolExecutor(max_workers=4) as executor:
        executor.map(download_audio_safe, links)
    # signal all done
    status_queue.put({"type": "all_done"})

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/start_download", methods=["POST"])
def start_download():
    links_raw = request.form.get("links", "")
    # allow links split by newline or comma
    links = [l.strip() for l in re.split(r"[\n,]+", links_raw) if l.strip()]
    if links:
        threading.Thread(target=download_worker, args=(links,), daemon=True).start()
        return jsonify({"status": "started"})
    return jsonify({"status": "no_links"}), 400

@app.route("/progress")
def progress():
    messages = []
    # drain queue
    while not status_queue.empty():
        messages.append(status_queue.get())
    return jsonify(messages)

@app.route("/download/<path:filename>")
def download_file(filename):
    # serve files from downloads folder
    return send_from_directory(DOWNLOAD_FOLDER, filename, as_attachment=True)

if __name__ == "__main__":
    # Print helpful startup diagnostics
    print("Starting app...")
    print(f"FFMPEG_LOCATION detected: {FFMPEG_LOCATION!r}")
    print(f"aria2c available: {ARIA2C_AVAILABLE}")
    os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)
    app.run(debug=True, threaded=True, host="0.0.0.0", port=5000)
