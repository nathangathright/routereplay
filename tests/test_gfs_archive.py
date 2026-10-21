"""Local archive transport, provenance, interpolation and failure boundaries."""
from datetime import datetime, timedelta, timezone
import io
import json
from contextlib import redirect_stderr
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

SCRIPTS = Path(__file__).resolve().parents[1]/"skills"/"route-replay"/"scripts"
sys.path.insert(0, str(SCRIPTS))
import gfs_archive as archive
import prepare_weather_bundle as preparation


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers if headers is not None else {"Content-Length": str(len(body))}


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.cache = archive.DownloadCache(self.root)
        self.url = "https://www.ncei.noaa.gov/example.grb2"
        self.raw = b"GRIB"+b"01234567"+b"7777"
        self.bounds = (100, 115)

    def response(self, **overrides):
        headers = {"Content-Length": "16", "Content-Range": "bytes 100-115/1000", "ETag": '"source-object"'}
        headers.update(overrides)
        return Response(self.raw, 206, headers)

    def fetch(self):
        return self.cache.fetch(self.url, byte_range=self.bounds, max_bytes=20, require_grib=True)

    def test_exact_range_cached_by_content_and_offline_reused_without_network(self):
        with patch.object(archive, "urlopen", return_value=self.response()) as network:
            path, record = self.fetch()
        request = network.call_args.args[0]
        self.assertEqual(request.get_header("Range"), "bytes=100-115")
        self.assertEqual(path.name, record["sha256"])
        self.assertEqual(path.read_bytes(), self.raw)
        self.assertEqual(record["request"]["byte_range"], [100, 115])
        self.assertEqual(self.cache.downloaded_bytes, 16)
        offline = archive.DownloadCache(self.root, offline=True)
        with patch.object(archive, "urlopen", side_effect=AssertionError("network forbidden")):
            self.assertEqual(offline.fetch(self.url, byte_range=self.bounds, max_bytes=20, require_grib=True)[0], path)
        self.assertEqual(offline.network_requests, 0)

    def test_offline_missing_object_is_not_fetched(self):
        self.cache.offline = True
        with patch.object(archive, "urlopen", side_effect=AssertionError("network forbidden")):
            with self.assertRaisesRegex(ValueError, "Offline NOAA cache miss"):
                self.fetch()

    def test_same_size_cache_corruption_is_fatal_not_replaced(self):
        with patch.object(archive, "urlopen", return_value=self.response()):
            path, _ = self.fetch()
        path.write_bytes(b"X"+self.raw[1:])
        with patch.object(archive, "urlopen", side_effect=AssertionError("network forbidden")):
            with self.assertRaisesRegex(ValueError, "Corrupt cached"):
                self.fetch()

    def test_ignored_range_never_reads_entire_model_file(self):
        response = self.response()
        response.status = 200
        with patch.object(response, "read", side_effect=AssertionError("must reject before reading")):
            with patch.object(archive, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "Expected HTTP 206"):
                    self.fetch()
        self.assertFalse((self.root/"requests").exists())

    def test_wrong_content_range_and_oversize_length_are_rejected(self):
        for headers in ({"Content-Range": "bytes 101-116/1000"}, {"Content-Length": "200000000"}, {"Content-Range": "bytes 100-115/115"}):
            with self.subTest(headers=headers):
                with patch.object(archive, "urlopen", return_value=self.response(**headers)):
                    with self.assertRaises(ValueError):
                        self.fetch()
        self.assertFalse((self.root/"requests").exists())

    def test_truncated_and_wrong_magic_payloads_publish_no_cache(self):
        for raw in (self.raw[:-1], b"XXXX"+self.raw[4:]):
            response = self.response()
            response = Response(raw, 206, response.headers)
            with patch.object(archive, "urlopen", return_value=response):
                with self.assertRaises(ValueError):
                    self.fetch()
        self.assertEqual(list(self.root.glob(".download-*")), [])
        self.assertFalse((self.root/"requests").exists())

    def test_content_length_missing_still_has_read_bound(self):
        response = self.response()
        response = Response(self.raw*100, 206, {"Content-Range": "bytes 100-115/1000"})
        with patch.object(archive, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "more data than the request bound"):
                self.fetch()
        self.assertLessEqual(self.cache.downloaded_bytes, 17)

    def test_request_budget_checked_before_network(self):
        self.cache.max_download_bytes = 15
        with patch.object(archive, "urlopen", side_effect=AssertionError("network forbidden")):
            with self.assertRaisesRegex(ValueError, "budget exceeded"):
                self.fetch()

    def test_missing_exact_object_does_not_search_another_provider(self):
        failure = HTTPError(self.url, 404, "missing", {}, None)
        with patch.object(archive, "urlopen", side_effect=failure) as network:
            with self.assertRaisesRegex(ValueError, "no alternate run or provider"):
                self.fetch()
        self.assertEqual(network.call_count, 1)

    def test_index_size_is_bounded_and_truncation_not_accepted(self):
        with patch.object(archive, "urlopen", return_value=Response(b"x"*11)):
            with self.assertRaisesRegex(ValueError, "Content-Length"):
                self.cache.fetch(self.url+".inv", max_bytes=10)
        self.assertFalse((self.root/"requests").exists())


class RedirectTests(unittest.TestCase):
    def setUp(self):
        self.url = "https://www.ncei.noaa.gov/oa/prod-model/a.grb2"
        self.request = Request(self.url, headers={"Range": "bytes=1-16"})
        self.handler = archive.ProviderRedirectHandler()

    def test_same_provider_https_redirect_preserves_range(self):
        result = self.handler.redirect_request(self.request, None, 302, "redirect", {}, "./b.grb2")
        self.assertEqual(result.full_url, "https://www.ncei.noaa.gov/oa/prod-model/b.grb2")
        self.assertEqual(result.get_header("Range"), "bytes=1-16")

    def test_downgrade_foreign_origin_and_cross_provider_rejected_before_hop(self):
        for target in ("http://www.ncei.noaa.gov/data", "https://example.invalid/data",
                       "https://noaa-gfs-bdp-pds.s3.amazonaws.com/data",
                       "https://www.ncei.noaa.gov:444/data", "https://user:secret@www.ncei.noaa.gov/data"):
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    self.handler.redirect_request(self.request, None, 302, "redirect", {}, target)

    def test_transport_installs_guarded_redirect_handler(self):
        with patch.object(archive, "build_opener") as factory:
            archive.urlopen(self.request, timeout=5)
        self.assertIsInstance(factory.call_args.args[0], archive.ProviderRedirectHandler)
        factory.return_value.open.assert_called_once_with(self.request, timeout=5)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.init = datetime(2023, 10, 1, tzinfo=timezone.utc)
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.cache = archive.DownloadCache(self.work.name)
        self.client = archive.GFSArchive("ncei-0p50", self.init, self.cache)

    def test_historical_plan_is_explicit_three_hourly_and_remains_forecast(self):
        result = preparation.plan(self.init, self.init+timedelta(hours=3), self.init+timedelta(hours=6), "ncei-0p50")
        self.assertEqual(result["layer_hours"], [3, 6])
        self.assertEqual(result["wind_hours"], [3, 6])
        self.assertEqual(result["profile_hours"], [3, 6])
        self.assertEqual(result["bounded_grib_records"], 98)
        self.assertEqual(result["source_mode"], "forecast")
        self.assertEqual(result["data_kind"], "archived_forecast")
        self.assertEqual(result["source_grid_degrees"], .5)
        self.assertIn("202310/20231001/gfs_4_20231001_0000_003.grb2", self.client.url(3))
        with self.assertRaises(ValueError):
            preparation.plan(self.init, self.init+timedelta(hours=190), self.init+timedelta(hours=193), "ncei-0p50")

    def test_default_provider_schedule_retains_hourly_states(self):
        result = preparation.plan(self.init, self.init+timedelta(hours=3), self.init+timedelta(hours=6))
        self.assertEqual(result["layer_hours"], [3, 4, 5, 6])
        self.assertEqual(result["provider"], "nodd-0p25")

    def test_archive_provenance_distinguishes_source_and_reconstruction(self):
        meta = self.client.source_metadata()
        self.assertEqual(meta["data_kind"], "archived_forecast")
        self.assertEqual(meta["source_mode"], "forecast")
        self.assertIn("not observations or reanalysis", meta["provider"]["notes"])
        self.assertIn("three-hourly", meta["provider"]["notes"])
        self.assertIn("bilinearly resampled", meta["provider"]["notes"])
        self.assertTrue(meta["provider"]["url"].startswith("https://www.ncei.noaa.gov/"))

    def test_inventory_initialization_checked_before_record_access(self):
        body = b"1:0:d=2023100200:UGRD:850 mb:3 hour fcst:\n2:20:d=2023100200:TMP:850 mb:3 hour fcst:\n"
        with patch.object(archive, "urlopen", return_value=Response(body)):
            with self.assertRaisesRegex(ValueError, "Inventory initialization differs"):
                self.client.describe(3, "UGRD", 850)

    def test_index_selects_only_instantaneous_not_averaged_field(self):
        lines = ["1:0:d=2023100100:LCDC:low cloud layer:0-3 hour ave fcst:",
                 "2:20:d=2023100100:LCDC:low cloud layer:3 hour fcst:",
                 "3:40:d=2023100100:HCDC:high cloud layer:3 hour fcst:"]
        result = archive.select_record(lines, 3, "LCDC", "low cloud layer")
        self.assertEqual(result["byte_range"], [20, 39])
        with self.assertRaises(ValueError):
            archive.select_record(lines[:1], 3, "LCDC", "low cloud layer")

    def test_zero_hour_uses_analysis_record_without_changing_source_mode(self):
        lines = ["1:0:d=2023100100:UGRD:850 mb:anl:", "2:20:d=2023100100:VGRD:850 mb:anl:"]
        self.assertEqual(archive.select_record(lines, 0, "UGRD", 850)["byte_range"], [0, 19])

    def test_sparse_archive_gap_is_error_before_any_grib_download(self):
        schedule = preparation.plan(self.init, self.init+timedelta(hours=3), self.init+timedelta(hours=6), "ncei-0p50")
        with patch.object(self.client, "describe", side_effect=ValueError("Exact NOAA object unavailable")):
            with patch.object(self.client, "get_record", side_effect=AssertionError("GRIB forbidden")):
                with self.assertRaisesRegex(ValueError, "Exact NOAA object unavailable"):
                    self.client.preflight(schedule)

    def test_bilinear_coverage_preserves_native_nodes_poles_and_wrap(self):
        import numpy as np
        preparation.np = np
        source = np.arange(361, dtype=np.float32)[:, None]+np.arange(720, dtype=np.float32)[None, :]*.1
        result = preparation.upsample_coverage(source)
        self.assertEqual(result.shape, (721, 1440))
        np.testing.assert_array_equal(result[::2, ::2], source)
        np.testing.assert_allclose(result[::2, -1], (source[:, -1]+source[:, 0])*.5)
        np.testing.assert_allclose(result[1::2, ::2], (source[:-1]+source[1:])*.5)
        self.assertEqual(float(result.min()), float(source.min()))
        self.assertEqual(float(result.max()), float(source.max()))


class CLIRegressionTests(unittest.TestCase):
    """Run the distributed entrypoints without test-suite sys.path mutations."""
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.bundle = self.root/"bundle"
        self.args = ["--bundle", str(self.bundle), "--provider", "ncei-0p50",
                     "--initialization", "2023-10-01T00:00:00Z",
                     "--start", "2023-10-01T03:00:00Z", "--end", "2023-10-01T06:00:00Z"]

    def invoke(self, script, *args):
        # Ignore inherited PYTHONPATH and user site packages, while retaining
        # Python's normal entrypoint-directory import behavior for sibling files.
        return subprocess.run([sys.executable, "-E", "-s", str(SCRIPTS/script), *args], cwd=self.root,
                              text=True, capture_output=True, timeout=20)

    def test_standalone_plan_does_not_require_static_bundle(self):
        result = self.invoke("prepare_weather_bundle.py", *self.args, "--plan")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["bounded_grib_records"], 98)
        self.assertFalse(self.bundle.exists())

    def test_broken_conversion_bundle_fails_before_archive_or_cache_work(self):
        result = self.invoke("prepare_weather_bundle.py", *self.args, "--offline")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bundle.json", result.stderr)
        self.assertNotIn("Offline NOAA cache miss", result.stderr)
        self.assertFalse((self.bundle/"downloads").exists())
        # Also guard the online branch without making a network request.
        with patch.object(sys, "argv", ["prepare_weather_bundle.py", *self.args]):
            with patch.object(preparation, "GFSArchive", side_effect=AssertionError("archive must not start")):
                with redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        preparation.main()

    def test_standalone_acquisition_modes_allow_no_bundle(self):
        for mode in ("--check-availability", "--download-only"):
            result = self.invoke("prepare_weather_bundle.py", *self.args, mode, "--offline")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Offline NOAA cache miss", result.stderr)
            self.assertNotIn("bundle.json", result.stderr)

    def test_standalone_bundle_verify_has_no_test_import_path_dependency(self):
        import data
        self.bundle.mkdir()
        records = {}
        for name, spec in data.static_specs(10).items():
            path = self.bundle/spec["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((name+" portable fixture").encode())
            records[name] = data.file_record(self.bundle, spec["path"], spec["source"])
        data.write_json(self.bundle/"bundle.json", {"schema_version": 1, "surface_month": 10,
                                                   "assets": records, "weather": None})
        result = self.invoke("data.py", "verify", str(self.bundle))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["valid"])


class GRIBGridRegressionTests(unittest.TestCase):
    def test_wrong_ncei_grid_rejected_before_decoding_values(self):
        import numpy as np
        init = datetime(2023, 10, 1, tzinfo=timezone.utc)
        header = {"dataDate": 20231001, "dataTime": 0, "validityDate": 20231001, "validityTime": 300,
                  "stepType": "instant", "startStep": 3, "endStep": 3, "Ni": 1440, "Nj": 361}
        with tempfile.TemporaryDirectory() as work:
            path = Path(work)/"record"
            path.write_bytes(b"GRIB7777")
            source = SimpleNamespace(spec=archive.provider_spec("ncei-0p50", init), get_record=lambda *args: (
                path, {"source_url": "https://www.ncei.noaa.gov/data", "byte_range": [0, 7]}))
            decoder = SimpleNamespace(codes_grib_new_from_file=lambda handle: object(), codes_get=lambda message, key: header[key],
                                      codes_release=lambda message: None,
                                      codes_get_values=lambda message: self.fail("must validate dimensions before reading values"))
            for key, ni, nj, expected in (("Ni", 1440, 361, 720), ("Nj", 720, 721, 361)):
                header.update(Ni=ni, Nj=nj)
                with self.subTest(dimension=key):
                    with patch.object(preparation, "ARCHIVE", source), patch.object(preparation, "INIT", init), \
                         patch.object(preparation, "np", np), patch.object(preparation, "eccodes", decoder):
                        with self.assertRaisesRegex(ValueError, f"Unexpected {key}={header[key]}, expected {expected}"):
                            preparation.record(3, "UGRD", 850, "wind")


if __name__ == "__main__":
    unittest.main()
