from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
from downloader import submit_download, get_progress, get_all_progress, DOWNLOADS_DIR

app = Flask(__name__, static_folder="../frontend", static_url_path="/")
CORS(app)

# Serve frontend
@app.route("/")
def index():
    return app.send_static_file("index.html")

@app.route("/<path:path>")
def serve_static(path):
    # serve CSS/JS and other frontend files
    return app.send_static_file(path)

# API: submit multiple links
@app.route("/api/downloads", methods=["POST"])
def api_downloads():
    payload = request.get_json()
    if not payload:
        return jsonify({"error": "JSON body required"}), 400

    links = payload.get("links") or payload.get("urls") or []
    if not isinstance(links, list) or len(links) == 0:
        return jsonify({"error": "Provide a 'links' array with one or more URLs"}), 400

    task_map = {}
    for url in links:
        if not url or not isinstance(url, str):
            continue
        task_id = submit_download(url.strip())
        task_map[task_id] = {"url": url}

    return jsonify({"tasks": task_map}), 202

# API: submit single link
@app.route("/api/download", methods=["POST"])
def api_download():
    payload = request.get_json()
    if not payload:
        return jsonify({"error": "JSON body required"}), 400
    url = payload.get("url")
    if not url:
        return jsonify({"error": "Provide a 'url' field"}), 400
    task_id = submit_download(url.strip())
    return jsonify({"task_id": task_id}), 202

# API: check progress of one task
@app.route("/api/progress/<task_id>", methods=["GET"])
def api_progress(task_id):
    return jsonify(get_progress(task_id))

# API: list all tasks progress
@app.route("/api/progress", methods=["GET"])
def api_progress_all():
    return jsonify(get_all_progress())

# Serve downloaded files
@app.route("/downloads/<path:filename>", methods=["GET"])
def serve_file(filename):
    return send_from_directory(DOWNLOADS_DIR, filename, as_attachment=True)

if __name__ == "__main__":
    # ensure downloads dir exists (downloader already creates normally)
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    # run on localhost:5000
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
