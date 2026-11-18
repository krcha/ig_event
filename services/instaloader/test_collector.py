"""Offline protocol, metadata integrity and crash-safety regression tests."""

import copy
import json
import multiprocessing
import os
import pickle
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from datetime import datetime, timezone

from collector import (BoundedHTTPServer, Collector, CollectorError, Journal, RateHistory, SHORTCODE_ALPHABET,
                       collect_posts, create_loader, make_handler, normalize_post,
                       session_availability, shortcode_media_id, upstream_failure_result, validate_request)


def shortcode(value):
    number = int(value)
    chars = []
    while number:
        chars.append(SHORTCODE_ALPHABET[number % 64])
        number //= 64
    return "".join(reversed(chars))


def request(**changes):
    value = {"requestId": "fixture-1", "target": "@source_venue", "resultsLimit": 6,
             "onlyPostsNewerThan": "2026-10-11T00:00:00.000Z", "skipPinnedPosts": False,
             "pinnedPostPolicy": "include_recent", "timeoutSeconds": 5}
    value.update(changes)
    return validate_request(value)


def media(**changes):
    value = {"pk": 3877777777777777777, "code": shortcode(3877777777777777777), "media_type": 1,
             "user": {"pk": "9888888888888888888", "username": "original_owner"},
             "taken_at": 1791763200, "caption": {"text": "Two DJs, one event."},
             "image_versions2": {"candidates": [{"url": "https://cdn.example/cover.jpg"}]},
             "accessibility_caption": "Event flyer", "is_pinned": False,
             "location": {"name": "Verified Venue"}}
    value.update(changes)
    if "code" not in changes and type(value["pk"]) in (int, str):
        value["code"] = shortcode(value["pk"])
    return value


class Post:
    def __init__(self, node):
        self._node = {"iphone_struct": node}


class Feed:
    def __init__(self, values, has_next_page=False):
        values = list(values)
        self.iterator = iter(values)
        self._data = {"edges": values, "page_info": {"has_next_page": has_next_page}}
        self._page_index = 0

    def __iter__(self):
        return self

    def __next__(self):
        value = next(self.iterator)
        self._page_index += 1
        return value


def blocked_worker(connection):
    connection.recv()
    time.sleep(10)


def echo_worker(connection):
    while True:
        try:
            value = connection.recv()
        except EOFError:
            return
        time.sleep(0.15)
        connection.send((value["requestId"], 200, {"schemaVersion": 1, "items": [], "rawItemCount": 0}))


class SlowCollector(Collector):
    def start_worker(self):
        self.stop_worker()
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=blocked_worker, args=(child,), daemon=True)
        self.process.start()
        child.close()


class QueuedCollector(Collector):
    def start_worker(self):
        self.stop_worker()
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=echo_worker, args=(child,), daemon=True)
        self.process.start()
        child.close()


class CollectorTests(unittest.TestCase):
    def test_upstream_failure_diagnostics_are_sanitized_and_never_empty_success(self):
        from instaloader.exceptions import (AbortDownloadException, BadResponseException,
                                           LoginRequiredException, QueryReturnedNotFoundException)
        secret = "private-session-cookie-and-checkpoint-url"
        for error, expected in (
            (BadResponseException(secret), "metadata_unavailable"),
            (QueryReturnedNotFoundException(secret), "upstream_not_found"),
            (LoginRequiredException(secret), "authentication_required"),
            (AbortDownloadException(secret), "upstream_aborted"),
            (KeyError(secret), "unexpected_metadata_shape"),
            (RuntimeError(secret), "unclassified_failure"),
        ):
            with self.subTest(expected=expected):
                status, value = upstream_failure_result(error, "fixture-diagnostic")
                self.assertEqual(status, 503)
                self.assertEqual(value["error"]["code"], "instagram_unavailable")
                self.assertEqual(value["error"]["diagnosticCause"], expected)
                self.assertFalse(value["error"]["retryable"])
                self.assertNotIn("items", value)
                self.assertNotIn(secret, json.dumps(value))

    def test_rules_and_target_validation(self):
        value = request()
        self.assertEqual(value["target"], "source_venue")
        self.assertEqual(value["onlyPostsNewerThan"], "2026-10-11T00:00:00.000Z")
        for path in ("p", "reel", "reels", "tv"):
            value = request(target="https://www.instagram.com/" + path + "/ExamplePost/?igsh=tracking")
            self.assertEqual((value["kind"], value["target"]), ("post", "ExamplePost"))
        bad = [{"target": "https://instagram.com.evil.test/p/Ab/"},
               {"target": "https://user:secret@instagram.com/p/Ab/"},
               {"target": "https://instagram.com:broken/p/Ab/"},
               {"target": "https://instagram.com/p/Ab/more/"},
               {"target": "https://instagram.com/venue/"},
               {"resultsLimit": True}, {"resultsLimit": 21}, {"skipPinnedPosts": "true"},
               {"onlyPostsNewerThan": "2026-10-11T00:00:00"}, {"timeoutSeconds": float("nan")},
               {"skipPinnedPosts": True, "pinnedPostPolicy": "include_recent", "onlyPostsNewerThan": None},
               {"password": "ignored-secret"}]
        for changes in bad:
            with self.subTest(changes=changes), self.assertRaises(CollectorError) as context:
                request(**changes)
            self.assertEqual(context.exception.code, "invalid_request")

    def test_exact_ids_owner_timestamp_and_available_optional_metadata(self):
        value = normalize_post(media())
        self.assertEqual(value["id"], "3877777777777777777")
        self.assertEqual(value["ownerId"], "9888888888888888888")
        self.assertEqual(value["ownerUsername"], "original_owner")
        self.assertEqual(value["timestamp"], "2026-10-12T00:00:00.000Z")
        self.assertEqual(value["caption"], "Two DJs, one event.")
        self.assertEqual(value["alt"], "Event flyer")
        self.assertEqual(value["locationName"], "Verified Venue")
        self.assertEqual(value["url"], "https://www.instagram.com/p/" + shortcode(3877777777777777777) + "/")
        self.assertEqual(shortcode_media_id(value["shortCode"]), value["id"])
        with self.assertRaises(CollectorError) as context:
            normalize_post(media(code="ExamplePost"))
        self.assertEqual(context.exception.code, "identity_mismatch")

    def test_mixed_carousel_preserves_order_complete_count_and_thumbnail(self):
        children = [
            {"pk": "3888888888888888881", "media_type": 1, "image_versions2": {"candidates": [
                {"url": "https://cdn.example/slide1.jpg"}, {"url": "https://cdn.example/slide1-small.jpg"}]}},
            {"pk": "3888888888888888882", "media_type": 2, "image_versions2": {"candidates": [
                {"url": "https://cdn.example/video2-thumbnail.jpg"}]}, "video_versions": [{"url": "https://cdn.example/video2.mp4"}]},
            {"pk": "3888888888888888883", "media_type": 1, "image_versions2": {"candidates": [
                {"url": "https://cdn.example/slide3.jpg"}]}}
        ]
        raw = media(media_type=8, carousel_media_count=3, carousel_media=children)
        result = normalize_post(raw)
        self.assertEqual(result["childPostsCount"], 3)
        self.assertEqual(result["carouselMediaCount"], 3)
        self.assertEqual([child["index"] for child in result["childPosts"]], [0, 1, 2])
        self.assertEqual([child["type"] for child in result["childPosts"]], ["Image", "Video", "Image"])
        self.assertEqual(result["childPosts"][1]["displayUrl"], "https://cdn.example/video2-thumbnail.jpg")
        self.assertEqual(len(result["childPosts"][0]["image_versions2"]["candidates"]), 2)
        self.assertNotIn("videoUrl", result["childPosts"][1])
        partial = copy.deepcopy(raw)
        partial["carousel_media"] = partial["carousel_media"][:2]
        with self.assertRaises(CollectorError) as context:
            normalize_post(partial)
        self.assertEqual(context.exception.code, "incomplete_carousel")
        repeated = copy.deepcopy(raw)
        repeated["carousel_media"][1]["pk"] = repeated["carousel_media"][0]["pk"]
        with self.assertRaises(CollectorError):
            normalize_post(repeated)
        missing_thumb = copy.deepcopy(raw)
        missing_thumb["carousel_media"][1]["image_versions2"]["candidates"] = []
        with self.assertRaises(CollectorError):
            normalize_post(missing_thumb)

    def test_legacy_graphql_and_owner_never_inferred_from_queried_profile(self):
        raw = {"id": "3877777777777777777", "shortcode": shortcode(3877777777777777777), "__typename": "GraphImage",
               "owner": {"id": "9999999999999999999", "username": "source_original"},
               "taken_at_timestamp": 1791763200, "edge_media_to_caption": {"edges": []},
               "display_url": "https://cdn.example/graph.jpg", "pinned_for_users": []}
        value = normalize_post(raw)
        self.assertEqual(value["ownerUsername"], "source_original")
        self.assertIsNone(value["caption"])
        del raw["owner"]
        with self.assertRaises(CollectorError) as context:
            normalize_post(raw)
        self.assertEqual(context.exception.code, "owner_unknown")
        unsafe_id = media(pk=3877777777777777777.0)
        with self.assertRaises(CollectorError):
            normalize_post(unsafe_id)

    def test_date_eligible_window_skips_old_pinned_rows_and_keeps_foreign_owner(self):
        old = media(pk="1", taken_at=1767225600, is_pinned=True)
        recent = media(pk="2")
        later = media(pk="3", taken_at=1791763201)
        result = collect_posts(Feed([Post(old), Post(recent), Post(later)]), request(resultsLimit=2), time.monotonic() + 10)
        self.assertEqual([item["id"] for item in result["items"]], ["2", "3"])
        self.assertEqual(result["rawItemCount"], 2)
        self.assertEqual(result["inspectedItemCount"], 3)
        self.assertEqual(result["items"][0]["ownerUsername"], "original_owner")
        old_pins = [Post(media(pk=str(index + 1), taken_at=1767225600, is_pinned=True,
                              media_type=8, carousel_media_count=3, carousel_media=[])) for index in range(3)]
        fresh = [Post(media(pk=str(index + 4))) for index in range(6)]
        result = collect_posts(Feed(old_pins + fresh), request(), time.monotonic() + 10)
        self.assertEqual(result["rawItemCount"], 6)
        self.assertEqual(result["inspectedItemCount"], 9)
        self.assertEqual([item["id"] for item in result["items"]], ["4", "5", "6", "7", "8", "9"])

    def test_pin_exclusion_refuses_unknown_and_include_recent_accepts_unknown(self):
        unknown = media()
        del unknown["is_pinned"]
        with self.assertRaises(CollectorError) as context:
            collect_posts([Post(unknown)], request(skipPinnedPosts=True, pinnedPostPolicy="exclude_all"), time.monotonic() + 10)
        self.assertEqual(context.exception.code, "pin_status_unknown")
        result = collect_posts(Feed([Post(unknown)]), request(skipPinnedPosts=False), time.monotonic() + 10,
            now=datetime(2026, 10, 12, 12, tzinfo=timezone.utc))
        self.assertEqual(len(result["items"]), 1)
        self.assertNotIn("isPinned", result["items"][0])
        pinned, ordinary = media(pk="1", is_pinned=True), media(pk="2", is_pinned=False)
        result = collect_posts(Feed([Post(pinned), Post(ordinary)]), request(skipPinnedPosts=True, pinnedPostPolicy="exclude_all"), time.monotonic() + 10, known_total=2)
        self.assertEqual([item["id"] for item in result["items"]], ["2"])
        with self.assertRaises(CollectorError):
            collect_posts(Feed([Post(unknown)]), request(skipPinnedPosts=True, resultsLimit=1), time.monotonic() + 10,
                now=datetime(2026, 10, 12, 12, tzinfo=timezone.utc))

    def test_unknown_pins_apply_same_age_and_manual_policy_rules(self):
        now = datetime(2026, 10, 12, 12, tzinfo=timezone.utc)
        unknown = media(is_pinned=False)
        del unknown["is_pinned"]
        old = media(taken_at=1791504000)
        del old["is_pinned"]
        old_request = request(resultsLimit=1, onlyPostsNewerThan="2026-10-02T00:00:00.000Z")
        self.assertEqual(collect_posts([Post(unknown)], old_request, time.monotonic() + 10, now=now)["rawItemCount"], 1)
        with self.assertRaises(CollectorError) as context:
            collect_posts([Post(old)], old_request, time.monotonic() + 10, now=now)
        self.assertEqual(context.exception.code, "pin_status_unknown")
        outside_age_window = request(resultsLimit=1)
        self.assertEqual(collect_posts(Feed([Post(old)]), outside_age_window, time.monotonic() + 10, known_total=1, now=now)["rawItemCount"], 0)
        all_pins = request(resultsLimit=1, pinnedPostPolicy="include_all", onlyPostsNewerThan=None)
        self.assertEqual(collect_posts([Post(old)], all_pins, time.monotonic() + 10, now=now)["rawItemCount"], 1)
        exclude_without_skip = request(resultsLimit=1, pinnedPostPolicy="exclude_all", skipPinnedPosts=False)
        with self.assertRaises(CollectorError):
            collect_posts([Post(unknown)], exclude_without_skip, time.monotonic() + 10, now=now)

    def test_pagination_stop_requires_explicit_exhaustion_and_confirmed_zero_count(self):
        for feed, count, expected_code in [
            (Feed([], has_next_page=True), 5, "incomplete_feed"),
            (Feed([Post(media())], has_next_page=True), 5, "incomplete_feed"),
            (Feed([]), 5, "unconfirmed_empty_feed"),
            (Feed([]), None, "unconfirmed_empty_feed"),
        ]:
            with self.subTest(count=count), self.assertRaises(CollectorError) as context:
                collect_posts(feed, request(), time.monotonic() + 10, known_total=count)
            self.assertEqual(context.exception.code, expected_code)
        result = collect_posts(Feed([]), request(), time.monotonic() + 10, known_total=0)
        self.assertEqual(result, {"schemaVersion": 1, "items": [], "rawItemCount": 0, "inspectedItemCount": 0})
        result = collect_posts(Feed([Post(media())]), request(), time.monotonic() + 10, known_total=1)
        self.assertEqual(result["rawItemCount"], 1)

    def test_feed_failure_never_returns_partial_success_or_scans_past_window(self):
        def broken():
            yield Post(media())
            raise RuntimeError("provider failed after partial data")
        with self.assertRaises(RuntimeError):
            collect_posts(broken(), request(), time.monotonic() + 10)
        examined = []
        def long_old_feed():
            for index in range(201):
                examined.append(index)
                yield Post(media(pk=str(index + 1), taken_at=1767225600))
        with self.assertRaises(CollectorError) as context:
            collect_posts(long_old_feed(), request(), time.monotonic() + 10)
        self.assertEqual(context.exception.code, "incomplete_window")
        self.assertEqual(examined, list(range(40)))
        old = [Post(media(pk=str(index + 1), taken_at=1767225600)) for index in range(41)]
        with self.assertRaises(CollectorError) as context:
            collect_posts(Feed(old, has_next_page=True), request(), time.monotonic() + 10, known_total=41)
        self.assertEqual(context.exception.code, "incomplete_window")
        with self.assertRaises(CollectorError):
            collect_posts(Feed(old, has_next_page=False), request(), time.monotonic() + 10, known_total=41)
        filtered = collect_posts(Feed(old[:3]), request(), time.monotonic() + 10, known_total=3)
        self.assertEqual(filtered["rawItemCount"], 0)
        self.assertEqual(filtered["inspectedItemCount"], 3)
        duplicated = collect_posts([Post(media()), Post(media())], request(resultsLimit=2), time.monotonic() + 10)
        self.assertEqual(duplicated["rawItemCount"], 2)

    def test_session_requires_protected_regular_file_and_username(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session"
            path.write_bytes(b"not a real session; never loaded")
            config = {"session_file": str(path), "session_username": "fixture", "allow_anonymous": False}
            os.chmod(path, 0o600)
            self.assertTrue(session_availability(config))
            os.chmod(path, 0o644)
            self.assertFalse(session_availability(config))
            os.chmod(path, 0o600)
            config["session_username"] = ""
            self.assertFalse(session_availability(config))

    def test_journal_replay_rule_conflict_and_crash_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.sqlite3"
            journal = Journal(path)
            value = request()
            journal.start(value)
            result = {"schemaVersion": 1, "items": [], "rawItemCount": 0}
            journal.finish(value["requestId"], 200, result)
            self.assertEqual(journal.lookup(request(timeoutSeconds=2)), (200, result))
            status, output = journal.lookup(request(resultsLimit=3))
            self.assertEqual((status, output["error"]["code"]), (409, "request_id_conflict"))
            pending = request(requestId="crash-before-response")
            journal.start(pending)
            rate_history = RateHistory(path)
            rate_history.admit("fixture-before-network")
            self.assertEqual(journal.db.execute("SELECT state FROM requests WHERE request_id=?", (pending["requestId"],)).fetchone(), ("running",))
            rate_history.close()
            journal.close()
            journal = Journal(path)
            status, output = journal.lookup(pending)
            self.assertEqual((status, output["error"]["code"]), (409, "request_outcome_unknown"))
            journal.pause()
            self.assertGreater(journal.pause_remaining_seconds(), 0)
            self.assertLessEqual(journal.pause_remaining_seconds(), 900)
            journal.close()
            journal = Journal(path)
            self.assertTrue(journal.paused())
            journal.close()

    def test_successful_restart_restores_upstream_rate_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rates.sqlite3"
            history = RateHistory(path)
            history.admit("graphql-document", now=1000)
            history.admit("iphone", now=1010)
            history.close()
            restored = RateHistory(path)
            self.assertEqual(restored.restore(wall_now=1020, monotonic_now=500),
                {"graphql-document": [480], "iphone": [490]})
            self.assertEqual(restored.restore(wall_now=5000, monotonic_now=600), {})
            restored.close()

    def test_persisted_history_limits_fresh_instaloader_controller_without_network(self):
        try:
            import instaloader  # noqa: F401
        except ImportError:
            self.skipTest("Pinned Instaloader is not installed in this offline Python environment.")
        if instaloader.__version__ != "4.15.3":
            self.skipTest("The offline Python environment has another Instaloader release.")
        with tempfile.TemporaryDirectory() as directory:
            config = {"session_file": "/missing", "session_username": "", "allow_anonymous": True,
                      "rate_state_file": str(Path(directory) / "rates.sqlite3")}
            first = create_loader(config)
            first.context._rate_controller.wait_before_query("fixture-query")
            second = create_loader(config)
            second.context._rate_controller.count_per_sliding_window = lambda query: 1
            wait = second.context._rate_controller.query_waittime("fixture-query", time.monotonic())
            self.assertGreater(wait, 660)
            self.assertEqual(len(second.context._rate_controller._query_timestamps["fixture-query"]), 1)
            first.context._rate_controller.history.close()
            second.context._rate_controller.history.close()
            missing = {**config, "allow_anonymous": False, "rate_state_file": str(Path(directory) / "cold.sqlite3")}
            with self.assertRaises(CollectorError):
                create_loader(missing)
            cold = RateHistory(missing["rate_state_file"])
            self.assertEqual(cold.restore(), {})
            cold.close()

    def test_loaded_session_missing_auth_cookie_cannot_bootstrap_instagram(self):
        try:
            import instaloader  # noqa: F401
        except ImportError:
            self.skipTest("Pinned Instaloader is not installed in this offline Python environment.")
        if instaloader.__version__ != "4.15.3":
            self.skipTest("The offline Python environment has another Instaloader release.")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session"
            path.write_bytes(pickle.dumps({"csrftoken": "fixture-csrf"}))
            os.chmod(path, 0o600)
            config = {"session_file": str(path), "session_username": "fixture", "allow_anonymous": False,
                      "rate_state_file": str(Path(directory) / "rates.sqlite3")}
            with self.assertRaises(CollectorError) as context:
                create_loader(config)
            self.assertEqual(context.exception.code, "bad_session")
            history = RateHistory(config["rate_state_file"])
            self.assertEqual(history.restore(), {})
            history.close()
            path.write_bytes(pickle.dumps({"csrftoken": "fixture-csrf", "sessionid": "fixture-session"}))
            loader = create_loader(config)
            loader.context._session.cookies.clear()
            with self.assertRaises(CollectorError) as context:
                loader.context.doc_id_graphql_query("fixture", {})
            self.assertEqual(context.exception.code, "bad_session")
            self.assertEqual(loader.context._rate_controller.history.restore(), {})
            loader.context._rate_controller.history.close()

    def test_timeout_kills_background_worker_and_replay_never_repeats_it(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "journal.sqlite3")
            collector = SlowCollector({}, journal)
            value = request(timeoutSeconds=1)
            before = time.monotonic()
            status, output = collector.execute(value)
            self.assertEqual((status, output["error"]["code"]), (504, "deadline_exceeded"))
            self.assertLess(time.monotonic() - before, 4)
            self.assertIsNone(collector.process)
            self.assertEqual(collector.execute(value), (status, output))
            journal.close()

    def test_parallel_existing_six_lanes_wait_for_one_reused_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "journal.sqlite3")
            collector = QueuedCollector({}, journal)
            barrier = threading.Barrier(6)
            def run(index):
                barrier.wait()
                return collector.execute(request(requestId="parallel-" + str(index)))
            before = time.monotonic()
            with ThreadPoolExecutor(max_workers=6) as executor:
                results = list(executor.map(run, range(6)))
            elapsed = time.monotonic() - before
            self.assertTrue(all(status == 200 for status, _ in results))
            self.assertGreaterEqual(elapsed, 0.9)
            self.assertLess(elapsed, 5)
            self.assertTrue(collector.process.is_alive())
            pid = collector.process.pid
            self.assertEqual(collector.execute(request(requestId="parallel-0"))[0], 200)
            self.assertEqual(pid, collector.process.pid)
            collector.stop_worker()
            journal.close()

    def test_waiting_deadline_is_bounded_and_does_not_journal_unstarted_crawl(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "journal.sqlite3")
            collector = Collector({}, journal)
            collector.lock.acquire()
            value = request(timeoutSeconds=1)
            before = time.monotonic()
            status, output = collector.execute(value)
            self.assertEqual((status, output["error"]["code"]), (504, "queue_timeout"))
            self.assertLess(time.monotonic() - before, 2)
            self.assertIsNone(journal.lookup(value))
            self.assertIsNone(collector.process)
            collector.lock.release()
            journal.close()

    def test_bounded_queue_overflow_is_unstarted_and_cached_replay_still_works(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(Path(directory) / "journal.sqlite3")
            collector = Collector({}, journal)
            cached = request(requestId="cached-before-queue-filled")
            journal.start(cached)
            journal.finish(cached["requestId"], 200, {"schemaVersion": 1, "items": [], "rawItemCount": 0})
            for _ in range(8):
                self.assertTrue(collector.queue_slots.acquire(blocking=False))
            new = request(requestId="queue-overflow")
            status, output = collector.execute(new)
            self.assertEqual((status, output["error"]["code"]), (429, "collector_busy"))
            self.assertIsNone(journal.lookup(new))
            self.assertEqual(collector.execute(cached)[0], 200)
            self.assertIsNone(collector.process)
            for _ in range(8):
                collector.queue_slots.release()
            journal.close()

    def test_http_auth_validation_and_health_never_start_instagram(self):
        class FakeCollector:
            config = {"session_file": "/missing", "session_username": "", "allow_anonymous": False}
            calls = []
            journal = type("FakeJournal", (), {"paused": lambda self: False})()

            def execute(self, value):
                self.calls.append(value)
                return 200, {"schemaVersion": 1, "items": [], "rawItemCount": 0}

        fake = FakeCollector()
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(fake, "x" * 32))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:" + str(server.server_port)

        def send(path, body=None, token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            req = urllib.request.Request(base + path, data=body, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=3) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, json.load(error)

        try:
            self.assertEqual(send("/health")[0], 200)
            status, ready = send("/ready")
            self.assertEqual(status, 503)
            self.assertFalse(ready["instagramVerified"])
            self.assertFalse(ready["paused"])
            self.assertEqual(ready["retryAfterSeconds"], 0)
            self.assertEqual(ready["queueCapacity"], 8)
            value = request()
            value.pop("kind")
            status, output = send("/v1/scrape", json.dumps(value).encode())
            self.assertEqual((status, output["error"]["code"]), (401, "unauthorized"))
            self.assertEqual(fake.calls, [])
            self.assertEqual(send("/v1/scrape", b"malformed", "x" * 32)[0], 400)
            self.assertEqual(send("/v1/scrape", json.dumps(value).encode(), "x" * 32)[0], 200)
            self.assertEqual(len(fake.calls), 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_http_connections_are_bounded_before_auth_and_thread_creation(self):
        class StubCollector:
            config = {"session_file": "/missing", "session_username": "", "allow_anonymous": False}
            journal = type("FakeJournal", (), {"paused": lambda self: False})()
        server = BoundedHTTPServer(("127.0.0.1", 0), make_handler(StubCollector(), "x" * 32), max_connections=1)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        first = socket.create_connection(server.server_address, timeout=2)
        try:
            first.sendall(b"GET /health HTTP/1.1\r\nHost: local\r\n")
            until = time.monotonic() + 1
            while server.connection_slots._value != 0 and time.monotonic() < until:
                time.sleep(0.01)
            self.assertEqual(server.connection_slots._value, 0)
            second = socket.create_connection(server.server_address, timeout=2)
            try:
                self.assertEqual(second.recv(1), b"")
            finally:
                second.close()
        finally:
            first.close()
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
