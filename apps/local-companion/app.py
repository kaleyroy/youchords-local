import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from engine.convert_to_wav import convert_to_wav
from engine.main import get_last_process_timings, process_wav_file


APP_ROOT = Path(__file__).resolve().parent
ENGINE_ROOT = APP_ROOT / "engine"
ENGINE_TEMP = ENGINE_ROOT / "temp"
ENGINE_RESULTS = ENGINE_ROOT / "output" / "chords"
DATA_ROOT = Path(os.environ.get("YOUCHORDS_DATA_DIR", "/data")).resolve()
CACHE_ROOT = DATA_ROOT / "results"
UPLOAD_ROOT = DATA_ROOT / "uploads"
PAIRING_TOKEN = os.environ.get("YOUCHORDS_PAIRING_TOKEN", "").strip()
MAX_DURATION_SECONDS = int(os.environ.get("YOUCHORDS_MAX_DURATION_SECONDS", "2100"))
MAX_UPLOAD_BYTES = int(os.environ.get("YOUCHORDS_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

if len(PAIRING_TOKEN) < 32:
    raise RuntimeError("YOUCHORDS_PAIRING_TOKEN must contain at least 32 characters")

for directory in (ENGINE_TEMP, ENGINE_RESULTS, CACHE_ROOT, UPLOAD_ROOT):
    directory.mkdir(parents=True, exist_ok=True)


class JobRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    videoId: str | None = Field(default=None, min_length=11, max_length=11)


class JobRecord:
    def __init__(self, job_id: str, video_id: str):
        self.job_id = job_id
        self.video_id = video_id
        self.status = "queued"
        self.stage = "queued"
        self.error: str | None = None
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.timings: dict = {}

    def update(self, status: str, stage: str, error: str | None = None) -> None:
        self.status = status
        self.stage = stage
        self.error = error
        self.updated_at = time.time()

    def as_dict(self) -> dict:
        payload = {
            "jobId": self.job_id,
            "videoId": self.video_id,
            "status": self.status,
            "stage": self.stage,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        if self.error:
            payload["error"] = self.error
        if self.timings:
            payload["timings"] = self.timings
        return payload


app = FastAPI(title="YouChords Local Companion", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://[a-z]{32}|https://([a-z0-9-]+\.)?youtube\.com)$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

jobs: dict[str, JobRecord] = {}
jobs_lock = threading.Lock()
worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="youchords-analysis")


def require_pairing_token(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {PAIRING_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid local pairing token")


def extract_video_id(url: str, requested_id: str | None = None) -> str:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    if hostname == "youtu.be":
        candidate = parsed.path.strip("/").split("/", 1)[0]
    elif hostname in {"youtube.com", "music.youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            candidate = parsed.path.split("/", 2)[2].split("/", 1)[0]
        else:
            candidate = ""
    else:
        raise HTTPException(status_code=400, detail="Only YouTube URLs are supported")

    if not VIDEO_ID_RE.fullmatch(candidate):
        raise HTTPException(status_code=400, detail="Invalid YouTube video ID")
    if requested_id and requested_id != candidate:
        raise HTTPException(status_code=400, detail="Video ID does not match the YouTube URL")
    return candidate


def cached_result_path(video_id: str) -> Path:
    return CACHE_ROOT / f"{video_id}.json.gz"


def load_cached_result(video_id: str) -> dict | None:
    path = cached_result_path(video_id)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        path.unlink(missing_ok=True)
        return None


def cleanup_engine_temp() -> None:
    for child in ENGINE_TEMP.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def download_audio(url: str, job_dir: Path, record: JobRecord) -> Path:
    record.update("running", "downloading")
    output_template = str(job_dir / "source.%(ext)s")
    command = [
        "yt-dlp",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "--js-runtimes",
        "node",
        "--max-filesize",
        str(MAX_UPLOAD_BYTES),
        "--match-filter",
        f"duration >= 15 & duration <= {MAX_DURATION_SECONDS}",
        "--print",
        "after_move:filepath",
        "-f",
        "bestaudio/best",
        "-o",
        output_template,
        url,
    ]
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=900)
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "yt-dlp failed").strip().splitlines()[-1]
        raise RuntimeError(message[:500])

    candidates = [Path(line.strip()) for line in completed.stdout.splitlines() if line.strip()]
    source = next((path for path in reversed(candidates) if path.is_file()), None)
    if source is None:
        source = next((path for path in job_dir.glob("source.*") if path.is_file()), None)
    if source is None:
        raise RuntimeError("Downloaded audio file was not found")
    return source


def analyze_source(record: JobRecord, source: Path) -> None:
    record.update("running", "converting")
    staged_source = ENGINE_TEMP / f"{record.video_id}{source.suffix.lower()}"
    shutil.move(str(source), staged_source)
    wav_path = Path(convert_to_wav(str(staged_source)))
    staged_source.unlink(missing_ok=True)

    record.update("running", "analyzing")
    if not process_wav_file(str(wav_path)):
        raise RuntimeError("Chord analysis did not produce a result")

    generated = ENGINE_RESULTS / f"{record.video_id}.json.gz"
    if not generated.is_file():
        raise RuntimeError("Chord result file was not created")
    shutil.move(str(generated), cached_result_path(record.video_id))
    record.timings = get_last_process_timings()
    record.update("completed", "completed")


def run_job(record: JobRecord, source_provider) -> None:
    job_dir = UPLOAD_ROOT / record.job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    cleanup_engine_temp()
    try:
        if load_cached_result(record.video_id) is not None:
            record.update("completed", "cached")
            return

        source = source_provider(job_dir, record)
        analyze_source(record, source)
    except Exception as error:
        record.update("failed", "failed", str(error)[:500])
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
        cleanup_engine_temp()


def prune_jobs() -> None:
    with jobs_lock:
        if len(jobs) <= 100:
            return
        finished = sorted(
            (job for job in jobs.values() if job.status in {"completed", "failed"}),
            key=lambda job: job.updated_at,
        )
        for record in finished[: max(0, len(jobs) - 100)]:
            jobs.pop(record.job_id, None)


@app.on_event("startup")
def startup_cleanup() -> None:
    cleanup_engine_temp()


@app.on_event("shutdown")
def shutdown_worker() -> None:
    worker.shutdown(wait=False, cancel_futures=True)


@app.get("/v1/health", dependencies=[Depends(require_pairing_token)])
def health() -> dict:
    return {"ok": True, "service": "youchords-local", "version": "0.1.0"}


@app.post("/v1/jobs", dependencies=[Depends(require_pairing_token)])
def create_job(request: JobRequest) -> dict:
    video_id = extract_video_id(request.url, request.videoId)
    if load_cached_result(video_id) is not None:
        return {"jobId": None, "videoId": video_id, "status": "completed", "stage": "cached"}

    with jobs_lock:
        active = next(
            (job for job in jobs.values() if job.video_id == video_id and job.status in {"queued", "running"}),
            None,
        )
        if active:
            return active.as_dict()
        job_id = uuid.uuid4().hex
        record = JobRecord(job_id, video_id)
        jobs[job_id] = record

    worker.submit(run_job, record, lambda job_dir, job: download_audio(request.url, job_dir, job))
    prune_jobs()
    return record.as_dict()


@app.post("/v1/jobs/file", dependencies=[Depends(require_pairing_token)])
async def create_file_job(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "audio.bin").suffix.lower()[:10] or ".bin"
    upload_id = uuid.uuid4().hex
    job_dir = UPLOAD_ROOT / upload_id
    job_dir.mkdir(parents=True, exist_ok=True)
    upload_path = job_dir / f"upload{suffix}"
    digest = hashlib.sha256()
    total = 0

    try:
        with upload_path.open("wb") as handle:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Audio file is too large")
                digest.update(chunk)
                handle.write(chunk)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()

    if total == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Audio file is empty")

    video_id = digest.hexdigest()[:11]
    if load_cached_result(video_id) is not None:
        shutil.rmtree(job_dir, ignore_errors=True)
        return {"jobId": None, "videoId": video_id, "status": "completed", "stage": "cached"}

    record = JobRecord(upload_id, video_id)
    with jobs_lock:
        jobs[upload_id] = record

    def uploaded_source(_job_dir: Path, job: JobRecord) -> Path:
        job.update("running", "uploaded")
        return upload_path

    worker.submit(run_job, record, uploaded_source)
    prune_jobs()
    return record.as_dict()


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_pairing_token)])
def get_job(job_id: str) -> dict:
    with jobs_lock:
        record = jobs.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return record.as_dict()


@app.get("/v1/results/{video_id}", dependencies=[Depends(require_pairing_token)])
def get_result(video_id: str) -> dict:
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Invalid video ID")
    result = load_cached_result(video_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Result not found")
    return {"success": True, "videoId": video_id, "chordsData": result}


@app.delete("/v1/results/{video_id}", dependencies=[Depends(require_pairing_token)])
def delete_result(video_id: str) -> dict:
    if not VIDEO_ID_RE.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Invalid video ID")
    cached_result_path(video_id).unlink(missing_ok=True)
    return {"success": True}
