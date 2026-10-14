"""On-demand Instagram metadata collector. No account list, scheduler or writes to Eventzeka.

The parent process authenticates, journals and enforces deadlines. One reusable
worker owns Instaloader's session and rate controller. A timed-out worker is
terminated before accepting another crawl, including waits inside Instaloader.
Private Instaloader metadata access is intentionally isolated here: its public
sidecar iterator discards child IDs and some explicit carousel/pinning evidence.
"""

import hashlib
import hmac
import json
import math
import multiprocessing
import os
import re
import sqlite3
import stat
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HANDLE = re.compile(r"[A-Za-z0-9._]{1,30}\Z")
SHORTCODE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,200}\Z")
MAX_REQUEST_BYTES = 8192
MAX_SLIDES = 20
MAX_INSPECTED_POSTS = 40


class CollectorError(Exception):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def error_result(error, request_id=None):
    value = {"schemaVersion": 1, "error": {
        "code": error.code, "message": error.message, "retryable": False,
    }}
    if request_id is not None:
        value["requestId"] = request_id
    return error.status, value


def invalid(message):
    raise CollectorError("invalid_request", message, 400)


def parse_target(value):
    if not isinstance(value, str) or value != value.strip():
        invalid("target must be an Instagram handle or post URL.")
    if value.startswith("@"):
        value = value[1:]
    if HANDLE.fullmatch(value):
        return "profile", value.lower()
    try:
        parsed = urlparse(value)
        invalid_host = (parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com")
                        or parsed.username or parsed.password or parsed.port is not None or parsed.fragment)
    except ValueError:
        invalid("Invalid Instagram URL.")
    if invalid_host:
        invalid("Only HTTPS instagram.com post URLs are accepted.")
    parts = parsed.path.strip("/").split("/")
    if len(parts) != 2 or parts[0] not in ("p", "reel", "reels", "tv") or not SHORTCODE.fullmatch(parts[1]):
        invalid("Unsupported Instagram post URL.")
    return "post", parts[1]


def parse_cutoff(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 40:
        invalid("onlyPostsNewerThan must be a timezone-aware ISO timestamp or null.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        invalid("onlyPostsNewerThan must be a timezone-aware ISO timestamp or null.")
    if parsed.tzinfo is None:
        invalid("onlyPostsNewerThan must include a timezone.")
    return parsed.astimezone(timezone.utc)


def validate_request(value):
    if not isinstance(value, dict):
        invalid("Request must be an object.")
    allowed = {"requestId", "target", "resultsLimit", "onlyPostsNewerThan",
               "skipPinnedPosts", "pinnedPostPolicy", "timeoutSeconds"}
    if set(value) - allowed:
        invalid("Unknown request fields.")
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        invalid("requestId must contain 1-200 letters, numbers, dots, underscores, colons or hyphens.")
    kind, target = parse_target(value.get("target"))
    limit = value.get("resultsLimit")
    if type(limit) is not int or not 1 <= limit <= 20:
        invalid("resultsLimit must be an integer from 1 to 20.")
    skip = value.get("skipPinnedPosts")
    if type(skip) is not bool:
        invalid("skipPinnedPosts must be boolean.")
    policy = value.get("pinnedPostPolicy", "exclude_all" if skip else "include_all")
    if policy not in ("exclude_all", "include_recent", "include_all"):
        invalid("pinnedPostPolicy must be exclude_all, include_recent or include_all.")
    cutoff = parse_cutoff(value.get("onlyPostsNewerThan"))
    if skip and policy == "include_recent" and cutoff is None:
        invalid("include_recent requires onlyPostsNewerThan.")
    timeout = value.get("timeoutSeconds")
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 1 <= timeout <= 300:
        invalid("timeoutSeconds must be between 1 and 300.")
    # Canonicalization makes URL tracking parameters and handle case harmless.
    return {"requestId": request_id, "kind": kind, "target": target,
            "resultsLimit": limit, "skipPinnedPosts": skip, "pinnedPostPolicy": policy,
            "onlyPostsNewerThan": iso_utc(cutoff) if cutoff else None,
            "timeoutSeconds": float(timeout)}


def iso_utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def decimal_id(value):
    if type(value) is int and value > 0:
        return str(value)
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value):
        return value
    raise CollectorError("incomplete_metadata", "Provider omitted an exact decimal media or owner ID.")


def shortcode_media_id(code):
    # Same base64 alphabet/limit as Instaloader 4.15.3 Post.shortcode_to_mediaid.
    if not isinstance(code, str) or not 1 <= len(code) <= 11 or not SHORTCODE.fullmatch(code):
        raise CollectorError("identity_mismatch", "Provider returned an invalid media shortcode.")
    value = 0
    for char in code:
        value = value * 64 + SHORTCODE_ALPHABET.index(char)
    return str(value)


def image_urls(node):
    candidates = (node.get("image_versions2") or {}).get("candidates") or []
    values = [node.get("display_url"), node.get("displayUrl")]
    values.extend(candidate.get("url") for candidate in candidates if isinstance(candidate, dict))
    output = []
    for value in values:
        if not isinstance(value, str):
            continue
        parsed = urlparse(value)
        if parsed.scheme == "https" and parsed.hostname and value not in output:
            output.append(value)
    if not output:
        raise CollectorError("incomplete_metadata", "Provider omitted an image or video thumbnail.")
    return output


def media_type(node):
    raw = node.get("media_type", node.get("__typename"))
    mapping = {1: "Image", 2: "Video", 8: "Sidecar", "GraphImage": "Image",
               "GraphVideo": "Video", "GraphSidecar": "Sidecar"}
    if type(raw) in (int, str) and raw in mapping:
        return mapping[raw]
    if type(node.get("is_video")) is bool:
        return "Video" if node["is_video"] else "Image"
    raise CollectorError("incomplete_metadata", "Provider omitted an explicit media type.")


def pin_status(node):
    # Never call Post.is_pinned: its missing-field fallback is always false.
    evidence = []
    for key in ("is_pinned", "is_pinned_post", "isPinned"):
        if key in node:
            if type(node[key]) is not bool:
                raise CollectorError("pin_status_unknown", "Provider returned unsupported pin metadata.")
            evidence.append(node[key])
    if "pinned_for_users" in node:
        if not isinstance(node["pinned_for_users"], list):
            raise CollectorError("pin_status_unknown", "Provider returned unsupported pin metadata.")
        evidence.append(bool(node["pinned_for_users"]))
    if evidence and any(value != evidence[0] for value in evidence):
        raise CollectorError("pin_status_unknown", "Provider returned contradictory pin metadata.")
    return evidence[0] if evidence else None


def source_metadata(post):
    # Logged-in timeline posts retain complete raw mobile metadata here.
    raw = post._node.get("iphone_struct")
    if not isinstance(raw, dict):
        # Fetch original owner, not Post.owner_profile (which may be initialized
        # from the queried profile for a collaboration/repost).
        raw = post._full_metadata
    if not isinstance(raw, dict):
        raise CollectorError("incomplete_metadata", "Provider returned invalid post metadata.")
    return raw


def publication_date(node):
    timestamp = node.get("taken_at", node.get("taken_at_timestamp", node.get("date")))
    if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
        raise CollectorError("incomplete_metadata", "Provider omitted the publication timestamp.")
    try:
        return datetime.fromtimestamp(timestamp, timezone.utc)
    except (ValueError, OSError, OverflowError):
        raise CollectorError("incomplete_metadata", "Provider returned an invalid publication timestamp.")


def candidate_metadata(post):
    """Inspect feed timestamp/pinning without loading older post metadata."""
    node = post._node
    raw = node.get("iphone_struct") if isinstance(node, dict) else None
    if isinstance(raw, dict):
        return raw
    if isinstance(node, dict) and any(key in node for key in ("taken_at", "taken_at_timestamp", "date")):
        return node
    return source_metadata(post)


def feed_exhaustion_confirmed(iterator):
    data = getattr(iterator, "_data", None)
    page_info = data.get("page_info") if isinstance(data, dict) else None
    if not isinstance(page_info, dict) or page_info.get("has_next_page") is not False:
        return False
    edges = data.get("edges")
    page_index = getattr(iterator, "_page_index", None)
    if isinstance(edges, list) and type(page_index) is int and page_index < len(edges):
        return False
    return True


def normalize_post(node):
    post_id = decimal_id(node.get("pk", node.get("id")))
    code = node.get("code", node.get("shortcode"))
    if not isinstance(code, str) or not SHORTCODE.fullmatch(code):
        raise CollectorError("incomplete_metadata", "Provider omitted the post shortcode.")
    if shortcode_media_id(code) != post_id:
        raise CollectorError("identity_mismatch", "Provider media ID does not match its shortcode.")
    owner = node.get("user") or node.get("owner")
    if not isinstance(owner, dict) or not isinstance(owner.get("username"), str) or not HANDLE.fullmatch(owner["username"]):
        raise CollectorError("owner_unknown", "Provider omitted the original post owner.")
    owner_id = decimal_id(owner.get("pk", owner.get("id")))
    date = publication_date(node)
    if "caption" in node:
        caption = node["caption"]
        if isinstance(caption, dict):
            caption = caption.get("text")
    elif isinstance(node.get("edge_media_to_caption"), dict):
        edges = node["edge_media_to_caption"].get("edges")
        if not isinstance(edges, list):
            raise CollectorError("incomplete_metadata", "Provider returned invalid caption metadata.")
        caption = edges[0]["node"]["text"] if edges else None
    else:
        raise CollectorError("incomplete_metadata", "Provider omitted caption metadata.")
    if caption is not None and not isinstance(caption, str):
        raise CollectorError("incomplete_metadata", "Provider returned an invalid caption.")
    alt = node.get("accessibility_caption", node.get("alt"))
    if alt is not None and not isinstance(alt, str):
        raise CollectorError("incomplete_metadata", "Provider returned invalid accessibility metadata.")
    kind = media_type(node)
    urls = image_urls(node)
    result = {"id": post_id, "shortCode": code, "url": "https://www.instagram.com/p/" + code + "/",
              "ownerUsername": owner["username"], "ownerId": owner_id,
              "caption": caption, "alt": alt,
              "timestamp": iso_utc(date), "type": kind, "displayUrl": urls[0], "images": urls,
              "image_versions2": {"candidates": [{"url": url} for url in urls]}}
    pinned = pin_status(node)
    if pinned is not None:
        result["isPinned"] = pinned
    location = node.get("location")
    if isinstance(location, dict) and isinstance(location.get("name"), str):
        result["locationName"] = location["name"]
    if kind == "Sidecar":
        if isinstance(node.get("carousel_media"), list):
            children = node["carousel_media"]
            declared = node.get("carousel_media_count", len(children))
        else:
            edge = node.get("edge_sidecar_to_children") or {}
            edges = edge.get("edges")
            if not isinstance(edges, list):
                raise CollectorError("incomplete_carousel", "Provider omitted the carousel manifest.")
            children = [item.get("node") for item in edges if isinstance(item, dict)]
            declared = edge.get("count", len(edges))
        if type(declared) is not int or not 2 <= declared <= MAX_SLIDES or len(children) != declared:
            raise CollectorError("incomplete_carousel", "Provider carousel count does not match its complete manifest.")
        output = []
        child_ids = set()
        for index, child in enumerate(children):
            if not isinstance(child, dict):
                raise CollectorError("incomplete_carousel", "Provider returned an invalid carousel slide.")
            child_id = decimal_id(child.get("pk", child.get("id")))
            child_code = child.get("code", child.get("shortcode"))
            if child_code is not None and child_code != "" and shortcode_media_id(child_code) != child_id:
                raise CollectorError("identity_mismatch", "Provider carousel slide ID does not match its shortcode.")
            if child_id in child_ids:
                raise CollectorError("incomplete_carousel", "Provider repeated a carousel slide ID.")
            child_ids.add(child_id)
            child_kind = media_type(child)
            if child_kind == "Sidecar":
                raise CollectorError("incomplete_carousel", "Provider returned a nested carousel.")
            child_urls = image_urls(child)
            output.append({"id": child_id, "type": child_kind, "isVideo": child_kind == "Video",
                           "index": index, "displayUrl": child_urls[0], "images": child_urls,
                           "image_versions2": {"candidates": [{"url": url} for url in child_urls]}})
            if child_code:
                output[-1]["shortCode"] = child_code
        result["childPosts"] = output
        result["carouselMediaCount"] = declared
        result["childPostsCount"] = declared
    return result


def collect_posts(posts, request, deadline, known_total=None, now=None):
    """Match the provider's date/pin-eligible window within a strict scan bound.

    Old pinned rows must not consume a date-eligible result slot. Ownership,
    deduplication and final pin-policy rules stay with the existing app selector.
    Do not assume chronological feed order or accept a short saturated window.
    Every carousel retained in this window is complete or the request fails.
    """
    items = []
    iterator = iter(posts)
    cutoff = parse_cutoff(request["onlyPostsNewerThan"])
    now = now or datetime.now(timezone.utc)
    limit = 1 if request["kind"] == "post" else request["resultsLimit"]
    inspected = 0
    exhausted = False
    while len(items) < limit and inspected < MAX_INSPECTED_POSTS:
        if time.monotonic() >= deadline:
            raise CollectorError("deadline_exceeded", "Collector deadline elapsed; no partial feed accepted.", 504)
        try:
            post = next(iterator)
        except StopIteration:
            exhausted = feed_exhaustion_confirmed(iterator)
            if request["kind"] == "post" and inspected == 1:
                exhausted = True
            if not exhausted:
                raise CollectorError("incomplete_feed", "Provider did not confirm exhaustion of the requested feed window.")
            break
        inspected += 1
        candidate = candidate_metadata(post)
        published_at = publication_date(candidate)
        if cutoff is not None and published_at <= cutoff:
            continue
        pinned = pin_status(candidate)
        if request["skipPinnedPosts"]:
            if pinned is None:
                raise CollectorError("pin_status_unknown", "Provider did not attest pin status; upstream exclusion cannot be preserved.")
            if pinned:
                continue
        if pinned is None:
            if request["pinnedPostPolicy"] == "exclude_all":
                raise CollectorError("pin_status_unknown", "Provider did not attest pin status; exclusion cannot be preserved.")
            if request["pinnedPostPolicy"] == "include_recent" and (now - published_at).total_seconds() > 86400:
                raise CollectorError("pin_status_unknown", "Provider did not attest whether an older eligible post is pinned.")
        raw = source_metadata(post)
        item = normalize_post(raw)
        if pinned is not None:
            if "isPinned" in item and item["isPinned"] != pinned:
                raise CollectorError("pin_status_unknown", "Provider returned contradictory pin metadata.")
            item["isPinned"] = pinned
        items.append(item)
    if len(items) < limit:
        exhausted = exhausted or feed_exhaustion_confirmed(iterator)
        if not exhausted:
            raise CollectorError("incomplete_window", "The inspected-post bound was reached before confirming the eligible window.")
        if not items and request["kind"] == "profile":
            if type(known_total) is not int or known_total < 0 or (inspected == 0 and known_total != 0) or (inspected > 0 and known_total == 0):
                raise CollectorError("unconfirmed_empty_feed", "Provider did not confirm an empty or fully filtered feed.")
    return {"schemaVersion": 1, "items": items, "rawItemCount": len(items), "inspectedItemCount": inspected}


def session_availability(config):
    filename, username = config["session_file"], config["session_username"]
    if filename and username:
        try:
            info = os.lstat(filename)
            if stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and os.access(filename, os.R_OK):
                return True
        except OSError:
            pass
    return False


def create_loader(config):
    import instaloader
    if instaloader.__version__ != "4.15.3":
        raise CollectorError("incompatible_version", "Collector requires the pinned Instaloader release.")
    available = session_availability(config)
    if not available and not config["allow_anonymous"]:
        raise CollectorError("session_unavailable", "A readable protected Instagram session is required.")

    class DeadlineRateController(instaloader.RateController):
        deadline = math.inf

        def __init__(self, context):
            super().__init__(context)
            self.history = RateHistory(config["rate_state_file"])
            self._query_timestamps = self.history.restore()

        def wait_before_query(self, query_type):
            super().wait_before_query(query_type)
            # This method returns immediately before Instaloader invokes HTTP.
            # Persist admission first: crashes and restarts cannot reset quotas.
            self.history.admit(query_type)

        def sleep(self, seconds):
            if time.monotonic() + seconds >= self.deadline:
                raise CollectorError("rate_limited", "Required rate-limit wait exceeds this request's deadline.")
            super().sleep(seconds)

        def handle_429(self, query_type):
            raise CollectorError("rate_limited", "Instagram requested rate limiting; no automatic retry.")

    loader = instaloader.Instaloader(quiet=True, download_pictures=False, download_videos=False,
        download_video_thumbnails=False, download_geotags=False, download_comments=False,
        save_metadata=False, max_connection_attempts=1, request_timeout=10,
        rate_controller=DeadlineRateController, fatal_status_codes=[400, 401, 403, 429],
        iphone_support=False)
    # Never print responses, cookies, session paths or request parameters.
    loader.context.log = lambda *args, **kwargs: None
    loader.context.error = lambda *args, **kwargs: None
    if available:
        try:
            loader.load_session_from_file(config["session_username"], config["session_file"])
        except Exception:
            loader.context._rate_controller.history.close()
            raise CollectorError("session_unavailable", "The protected Instagram session could not be loaded.")
        cookies = loader.context._session.cookies.get_dict()
        if any(not isinstance(cookies.get(name), str) or not cookies[name].strip()
               for name in ("csrftoken", "sessionid")):
            loader.context._rate_controller.history.close()
            raise CollectorError("bad_session", "The protected Instagram session is missing required authentication cookies.")
    original_graphql_query = loader.context.doc_id_graphql_query

    def guarded_graphql_query(*args, **kwargs):
        # Upstream otherwise bootstraps an untracked homepage request when a
        # CSRF cookie is missing. Refuse that path instead of resetting quotas.
        cookies = loader.context._session.cookies.get_dict()
        if not isinstance(cookies.get("csrftoken"), str) or not cookies["csrftoken"].strip():
            raise CollectorError("bad_session", "The Instagram session no longer has required authentication cookies.")
        return original_graphql_query(*args, **kwargs)

    loader.context.doc_id_graphql_query = guarded_graphql_query
    return loader


def worker_main(connection, config):
    loader = None
    while True:
        try:
            request = connection.recv()
        except EOFError:
            return
        request_id = request["requestId"]
        try:
            if loader is None:
                loader = create_loader(config)
            deadline = request["deadline"]
            loader.context._rate_controller.deadline = deadline
            loader.context.request_timeout = min(10, max(1, deadline - time.monotonic()))
            import instaloader
            if request["kind"] == "post":
                posts = [instaloader.Post.from_shortcode(loader.context, request["target"])]
            else:
                profile = instaloader.Profile.from_username(loader.context, request["target"])
                if profile.is_private:
                    raise CollectorError("private_profile", "Private profiles are not collected.")
                posts = profile.get_posts()
            try:
                known_total = profile.mediacount if request["kind"] == "profile" else None
            except Exception:
                known_total = None
            result = collect_posts(posts, request, deadline, known_total)
            connection.send((request_id, 200, result))
        except CollectorError as error:
            status, result = error_result(error, request_id)
            connection.send((request_id, status, result))
        except Exception:
            # Login/challenge/transport/schema errors are never empty success.
            status, result = error_result(CollectorError("instagram_unavailable",
                "Instagram metadata could not be collected; check session and provider availability."), request_id)
            connection.send((request_id, status, result))


class RateHistory:
    """Keep upstream admission history across successful worker/container restarts.

    Instaloader 4.15.3 retains one hour of query timestamps and enforces 600,
    660 and 1800 second windows. Persist wall times and map them to each worker's
    monotonic clock. No history is created by a missing-session preflight.
    """
    def __init__(self, filename):
        self.db = sqlite3.connect(filename, timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS rate_admissions (query_type TEXT NOT NULL, admitted_at REAL NOT NULL)")
        self.db.commit()

    def admit(self, query_type, now=None):
        now = time.time() if now is None else now
        self.db.execute("INSERT INTO rate_admissions VALUES (?,?)", (query_type, now))
        self.db.execute("DELETE FROM rate_admissions WHERE admitted_at < ?", (now - 3600,))
        self.db.commit()

    def restore(self, wall_now=None, monotonic_now=None):
        wall_now = time.time() if wall_now is None else wall_now
        monotonic_now = time.monotonic() if monotonic_now is None else monotonic_now
        rows = self.db.execute("SELECT query_type,admitted_at FROM rate_admissions WHERE admitted_at >= ? ORDER BY admitted_at", (wall_now - 3600,)).fetchall()
        output = {}
        for query_type, admitted_at in rows:
            output.setdefault(query_type, []).append(monotonic_now - (wall_now - admitted_at))
        return output

    def close(self):
        self.db.close()


class Journal:
    def __init__(self, filename):
        self.lock = threading.Lock()
        self.filename = str(filename)
        self.db = sqlite3.connect(filename, timeout=5, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, response TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value REAL NOT NULL)")
        # A previous process can have crawled before dying. Do not rerun it.
        self.db.execute("UPDATE requests SET state='unknown' WHERE state='running'")
        self.db.commit()

    def lookup(self, request):
        fingerprint = self.fingerprint(request)
        with self.lock:
            row = self.db.execute("SELECT fingerprint,state,status,response FROM requests WHERE request_id=?", (request["requestId"],)).fetchone()
        if row is None:
            return None
        if row[0] != fingerprint:
            return error_result(CollectorError("request_id_conflict", "requestId was already used with different rules.", 409), request["requestId"])
        if row[1] != "done":
            return error_result(CollectorError("request_outcome_unknown", "This request may already have collected data; automatic repetition is refused.", 409), request["requestId"])
        return row[2], json.loads(row[3])

    @staticmethod
    def fingerprint(request):
        rules = {key: value for key, value in request.items() if key not in ("requestId", "timeoutSeconds", "deadline")}
        return hashlib.sha256(json.dumps(rules, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def start(self, request):
        with self.lock:
            self.db.execute("INSERT INTO requests VALUES (?,?,'running',NULL,NULL)", (request["requestId"], self.fingerprint(request)))
            self.db.commit()

    def finish(self, request_id, status, response):
        with self.lock:
            self.db.execute("UPDATE requests SET state='done',status=?,response=? WHERE request_id=?", (status, json.dumps(response, separators=(",", ":")), request_id))
            self.db.commit()

    def close(self):
        self.db.close()

    def pause(self, seconds=900):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO control VALUES ('paused_until',?)", (time.time() + seconds,))
            self.db.commit()

    def paused(self):
        with self.lock:
            row = self.db.execute("SELECT value FROM control WHERE key='paused_until'").fetchone()
        return row is not None and row[0] > time.time()


class Collector:
    def __init__(self, config, journal):
        self.config, self.journal = {**config, "rate_state_file": journal.filename}, journal
        self.lock = threading.Lock()
        self.queue_slots = threading.BoundedSemaphore(8)
        self.process, self.connection = None, None

    def stop_worker(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
            self.process = None

    def start_worker(self):
        self.stop_worker()
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=worker_main, args=(child, self.config), daemon=True)
        self.process.start()
        child.close()

    def execute(self, request):
        deadline = time.monotonic() + request["timeoutSeconds"]
        cached = self.journal.lookup(request)
        if cached is not None:
            return cached
        if self.journal.paused():
            return error_result(CollectorError("collector_paused", "Instagram access is paused after a provider failure; no crawl started."), request["requestId"])
        # Accommodate the app's six existing fetch lanes with bounded waiting.
        # Queue time consumes the same end-to-end budget as network access.
        if not self.queue_slots.acquire(blocking=False):
            return error_result(CollectorError("collector_busy", "Collector queue is full; no crawl started.", 429), request["requestId"])
        if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
            self.queue_slots.release()
            return error_result(CollectorError("queue_timeout", "Collector deadline elapsed while waiting; no crawl started.", 504), request["requestId"])
        try:
            cached = self.journal.lookup(request)
            if cached is not None:
                return cached
            if self.journal.paused():
                return error_result(CollectorError("collector_paused", "Instagram access is paused after a provider failure; no crawl started."), request["requestId"])
            if time.monotonic() >= deadline:
                return error_result(CollectorError("queue_timeout", "Collector deadline elapsed while waiting; no crawl started.", 504), request["requestId"])
            self.journal.start(request)
            try:
                if self.process is None or not self.process.is_alive():
                    self.start_worker()
                self.connection.send({**request, "deadline": deadline})
                if not self.connection.poll(max(0, deadline - time.monotonic())):
                    self.stop_worker()
                    result = error_result(CollectorError("deadline_exceeded", "Collector deadline elapsed; worker stopped and no partial feed accepted.", 504), request["requestId"])
                else:
                    request_id, status, response = self.connection.recv()
                    if request_id != request["requestId"]:
                        raise RuntimeError("Worker response ID mismatch")
                    result = status, response
            except Exception:
                self.stop_worker()
                result = error_result(CollectorError("request_outcome_unknown", "Collector worker stopped with an unknown outcome; request will not be repeated.", 409), request["requestId"])
            self.journal.finish(request["requestId"], *result)
            if result[0] != 200 and result[1].get("error", {}).get("code") in ("instagram_unavailable", "rate_limited", "deadline_exceeded"):
                # Persist across container/worker restarts; do not challenge IG
                # again for every account in a large daily source list.
                self.journal.pause()
            return result
        finally:
            self.lock.release()
            self.queue_slots.release()


def make_handler(collector, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def respond(self, status, value):
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def do_GET(self):
            if self.path == "/health":
                self.respond(200, {"status": "ok", "schemaVersion": 1})
            elif self.path == "/ready":
                available = session_availability(collector.config)
                paused = collector.journal.paused()
                ready = (available or collector.config["allow_anonymous"]) and not paused
                self.respond(200 if ready else 503, {"ready": ready, "sessionAvailable": available,
                    "anonymousAllowed": collector.config["allow_anonymous"], "instagramVerified": False,
                    "paused": paused, "queueCapacity": 8})
            else:
                self.respond(*error_result(CollectorError("not_found", "Unknown endpoint.", 404)))

        def do_POST(self):
            if self.path != "/v1/scrape":
                self.respond(*error_result(CollectorError("not_found", "Unknown endpoint.", 404)))
                return
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied.encode("utf-8"), ("Bearer " + token).encode("utf-8")):
                self.respond(*error_result(CollectorError("unauthorized", "Authentication required.", 401)))
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                self.respond(*error_result(CollectorError("invalid_request", "Content-Type must be application/json.", 400)))
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_REQUEST_BYTES or self.headers.get("Transfer-Encoding"):
                    invalid("Request body length is unsupported.")
                body = self.rfile.read(size)
                if len(body) != size:
                    invalid("Request body is incomplete.")
                value = json.loads(body)
                request = validate_request(value)
                self.respond(*collector.execute(request))
            except CollectorError as error:
                self.respond(*error_result(error))
            except (ValueError, UnicodeDecodeError, TypeError, TimeoutError):
                self.respond(*error_result(CollectorError("invalid_request", "Request body is invalid.", 400)))
            except Exception:
                self.respond(*error_result(CollectorError("collector_unavailable", "Collector could not persist or complete the request.")))

    return Handler


class BoundedHTTPServer(ThreadingHTTPServer):
    """Bound connections before spawning threads, including unauthenticated ones."""
    daemon_threads = True

    def __init__(self, *args, max_connections=16, **kwargs):
        self.connection_slots = threading.BoundedSemaphore(max_connections)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()


def main():
    os.umask(0o077)
    token = os.environ.get("INSTALOADER_API_TOKEN", "")
    if len(token) < 32 or token != token.strip():
        raise SystemExit("INSTALOADER_API_TOKEN must contain at least 32 characters.")
    config = {"session_file": os.environ.get("INSTALOADER_SESSION_FILE", "/run/instaloader-session/session"),
              "session_username": os.environ.get("INSTALOADER_SESSION_USERNAME", ""),
              "allow_anonymous": os.environ.get("INSTALOADER_ALLOW_ANONYMOUS", "false") == "true"}
    state_dir = Path(os.environ.get("INSTALOADER_STATE_DIR", "/var/lib/eventzeka-instaloader"))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    journal = Journal(state_dir / "requests.sqlite3")
    collector = Collector(config, journal)
    server = BoundedHTTPServer(("0.0.0.0", int(os.environ.get("INSTALOADER_PORT", "8080"))), make_handler(collector, token))
    try:
        server.serve_forever()
    finally:
        server.server_close()
        collector.stop_worker()
        journal.close()


if __name__ == "__main__":
    main()
