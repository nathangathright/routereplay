"""Direct NOAA archive access with bounded requests and a local verified cache.

Neither provider needs credentials. Archived GFS is forecast model output, not
observations or observational reanalysis. This module never selects another run
or provider when an exact requested inventory or field is unavailable.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import tempfile
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from data import sha256, utc, write_json

PROVIDERS = ("nodd-0p25", "ncei-0p50")
NCEI_DOC = "https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast"
NODD_DOC = "https://registry.opendata.aws/noaa-gfs-bdp-pds/"
INDEX_LIMIT = 2_000_000
RECORD_LIMIT = 20_000_000
PROVIDER_HOSTS = {"www.ncei.noaa.gov", "noaa-gfs-bdp-pds.s3.amazonaws.com"}


def _provider_origin(url):
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.hostname not in PROVIDER_HOSTS or
            parts.port not in (None, 443) or parts.username is not None or parts.password is not None):
        raise ValueError("NOAA downloads require HTTPS on a supported provider host, without URL credentials")
    return parts.scheme, parts.hostname, parts.port or 443


class ProviderRedirectHandler(HTTPRedirectHandler):
    """Keep every redirect on the selected provider's HTTPS origin."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urljoin(req.full_url, newurl)
        if _provider_origin(req.full_url) != _provider_origin(target):
            raise ValueError("NOAA redirect changed provider origin; no alternate provider selected")
        return super().redirect_request(req, fp, code, msg, headers, target)


def urlopen(request, timeout=60):
    """Small injectable transport; redirect policy is enforced before each hop."""
    return build_opener(ProviderRedirectHandler()).open(request, timeout=timeout)


def provider_spec(provider, initialization):
    init = utc(initialization)
    if provider == "nodd-0p25":
        directory = f"https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{init:%Y%m%d}/{init:%H}/atmos/"
        return {"id": provider, "directory": directory, "filename": f"gfs.t{init:%H}z.pgrb2.0p25.f{{hour:03d}}",
                "index_suffix": ".idx", "grid_degrees": .25, "ni": 1440, "nj": 721,
                "hours": list(range(121))+list(range(123, 385, 3)), "max_hour": 384,
                "data_kind": "forecast", "documentation_url": NODD_DOC,
                "availability_note": "NCEI describes NODD high-resolution storage as a trailing 30-day window; exact objects are checked."}
    if provider == "ncei-0p50":
        directory = ("https://www.ncei.noaa.gov/oa/prod-model/global-forecast-system/access/"
                     f"grid-004-0.5-degree/forecast/{init:%Y%m}/{init:%Y%m%d}/")
        return {"id": provider, "directory": directory, "filename": f"gfs_4_{init:%Y%m%d}_{init:%H}00_{{hour:03d}}.grb2",
                "index_suffix": ".inv", "grid_degrees": .5, "ni": 720, "nj": 361,
                "hours": list(range(0, 193, 3)), "max_hour": 192,
                "data_kind": "archived_forecast", "documentation_url": NCEI_DOC,
                "availability_note": "NCEI long-term 0.5° archive; date/hour gaps are possible and cause an error. No alternate dates are selected."}
    raise ValueError(f"Unknown GFS provider: {provider}")


class DownloadCache:
    """Request-addressed index pointing to SHA256-addressed payloads.

    Cache hits check size and SHA before use. HTTP Range must be honored exactly;
    byte limits are checked before and while reading. The run-wide network budget
    includes inventories and GRIB payloads. Failed requests publish no cache entry.
    """
    def __init__(self, root, *, offline=False, max_download_bytes=512*1024*1024):
        if type(max_download_bytes) is not int or max_download_bytes <= 0:
            raise ValueError("Download budget must be a positive integer number of bytes")
        self.root = Path(root).expanduser().resolve()
        self.offline = offline
        self.max_download_bytes = max_download_bytes
        self.downloaded_bytes = 0
        self.network_requests = 0
        self._reserved_bytes = 0
        self._lock = Lock()

    @staticmethod
    def identity(url, byte_range=None):
        return {"url": url, "byte_range": list(byte_range) if byte_range is not None else None}

    def _entry_path(self, identity):
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        return self.root/"requests"/(key+".json")

    def cached(self, url, byte_range=None):
        identity = self.identity(url, byte_range)
        entry_path = self._entry_path(identity)
        if not entry_path.exists():
            return None
        entry = json.loads(entry_path.read_text())
        if (entry.get("request") != identity or not isinstance(entry.get("sha256"), str) or
                not re.fullmatch("[0-9a-f]{64}", entry["sha256"]) or
                type(entry.get("bytes")) is not int or entry["bytes"] <= 0):
            raise ValueError(f"Invalid cache metadata: {entry_path}")
        path = self.root/"objects"/entry["sha256"]
        if not path.is_file() or path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            raise ValueError(f"Corrupt cached NOAA payload: {path}; remove the affected cache entry before downloading again")
        return path, entry

    def fetch(self, url, *, byte_range=None, max_bytes=INDEX_LIMIT, require_grib=False):
        _provider_origin(url)
        if byte_range is not None:
            start, end = byte_range
            if type(start) is not int or type(end) is not int or start < 0 or end < start:
                raise ValueError("Invalid bounded byte range")
            if end-start+1 > max_bytes:
                raise ValueError("GRIB record exceeds the bounded download limit")
            reserve = end-start+1
        else:
            reserve = max_bytes
        cached = self.cached(url, byte_range)
        if cached:
            if cached[1]["bytes"] > max_bytes or (byte_range and cached[1]["bytes"] != end-start+1):
                raise ValueError("Cached object violates the requested byte bound")
            if require_grib:
                with cached[0].open("rb") as handle:
                    magic = handle.read(4)
                    handle.seek(-4, 2)
                    ending = handle.read(4)
                if magic != b"GRIB" or ending != b"7777":
                    raise ValueError("Cached payload is not a complete GRIB record")
            return cached
        if self.offline:
            raise ValueError(f"Offline NOAA cache miss: {url}" + (f" bytes={start}-{end}" if byte_range else ""))
        with self._lock:
            if self.downloaded_bytes+self._reserved_bytes+reserve > self.max_download_bytes:
                raise ValueError("NOAA network download budget exceeded; inspect the plan and increase --max-download-mib explicitly")
            self._reserved_bytes += reserve
        count = 0
        temporary = None
        try:
            headers = {"User-Agent": "route-replay/1 NOAA-local-archive"}
            if byte_range:
                headers["Range"] = f"bytes={start}-{end}"
            request = Request(url, headers=headers)
            with self._lock:
                self.network_requests += 1
            try:
                response = urlopen(request, timeout=60)
            except HTTPError as error:
                error.close()
                raise ValueError(f"Exact NOAA object unavailable (HTTP {error.code}): {url}; no alternate run or provider selected") from error
            with response:
                expected_status = 206 if byte_range else 200
                if response.status != expected_status:
                    raise ValueError(f"Expected HTTP {expected_status}, got {response.status}; refusing an unbounded or substituted response")
                if byte_range:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if not match or tuple(map(int, match.groups()[:2])) != (start, end) or int(match[3]) <= end:
                        raise ValueError("Server Content-Range does not match the exact requested GRIB range")
                length = response.headers.get("Content-Length")
                if length and (int(length) > max_bytes or (byte_range and int(length) != reserve)):
                    raise ValueError("Server Content-Length violates the bounded download")
                self.root.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile("wb", dir=self.root, prefix=".download-", delete=False) as handle:
                    temporary = Path(handle.name)
                    digest = hashlib.sha256()
                    bound = reserve if byte_range else max_bytes
                    while chunk := response.read(min(1024*1024, bound-count+1)):
                        count += len(chunk)
                        if count > max_bytes or (byte_range and count > reserve):
                            raise ValueError("Server returned more data than the request bound")
                        handle.write(chunk)
                        digest.update(chunk)
                if not count or (length and count != int(length)) or (byte_range and count != reserve):
                    raise ValueError("Incomplete bounded NOAA response")
                if require_grib:
                    with temporary.open("rb") as handle:
                        magic = handle.read(4)
                        handle.seek(-4, 2)
                        ending = handle.read(4)
                    if magic != b"GRIB" or ending != b"7777":
                        raise ValueError("Bounded NOAA payload is not a complete GRIB record")
                entry = {"request": self.identity(url, byte_range), "sha256": digest.hexdigest(), "bytes": count,
                         "retrieved_at": datetime.now(timezone.utc).isoformat(),
                         "etag": response.headers.get("ETag"), "last_modified": response.headers.get("Last-Modified")}
            path = self.root/"objects"/entry["sha256"]
            path.parent.mkdir(exist_ok=True)
            temporary.replace(path)
            temporary = None
            write_json(self._entry_path(entry["request"]), entry)
            return path, entry
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
            with self._lock:
                self._reserved_bytes -= reserve
                self.downloaded_bytes += count


def select_record(lines, hour, variable, level):
    level_text = f"{level} mb" if isinstance(level, int) else level
    step = "anl" if hour == 0 else f"{hour} hour fcst"
    wanted = f":{variable}:{level_text}:{step}:"
    matches = [i for i, line in enumerate(lines) if wanted in line]
    if len(matches) != 1 or matches[0] == len(lines)-1:
        raise ValueError(f"Expected one bounded instantaneous record: {wanted}")
    index = matches[0]
    start, end = int(lines[index].split(":")[1]), int(lines[index+1].split(":")[1])-1
    if start < 0 or not 0 < end-start+1 <= RECORD_LIMIT:
        raise ValueError("GRIB inventory has an invalid or oversized record range")
    return {"variable": variable, "level": level, "hour": hour, "index_record": lines[index],
            "byte_range": [start, end], "bytes": end-start+1}


class GFSArchive:
    def __init__(self, provider, initialization, cache):
        self.spec = provider_spec(provider, initialization)
        self.initialization = utc(initialization)
        self.cache = cache
        self._inventories = {}

    def url(self, hour):
        if hour not in self.spec["hours"]:
            raise ValueError(f"Hour {hour} is not in provider {self.spec['id']}'s documented schedule")
        return self.spec["directory"]+self.spec["filename"].format(hour=hour)

    def inventory(self, hour):
        if hour not in self._inventories:
            url = self.url(hour)
            path, meta = self.cache.fetch(url+self.spec["index_suffix"], max_bytes=INDEX_LIMIT)
            lines = path.read_text(encoding="ascii").splitlines()
            if not lines or any(not re.match(r"\d+:\d+:d=\d{10}:", line) for line in lines):
                raise ValueError(f"Unexpected NOAA inventory format: {url}")
            stamp = self.initialization.strftime("d=%Y%m%d%H")
            if any(line.split(":")[2] != stamp for line in lines):
                raise ValueError("Inventory initialization differs from the selected run")
            offsets = [int(line.split(":")[1]) for line in lines]
            if any(b <= a for a, b in zip(offsets, offsets[1:])):
                raise ValueError("Inventory offsets must increase strictly")
            self._inventories[hour] = (url, lines, meta)
        return self._inventories[hour]

    def describe(self, hour, variable, level):
        url, lines, index_meta = self.inventory(hour)
        record = select_record(lines, hour, variable, level)
        return {**record, "source_url": url, "inventory_sha256": index_meta["sha256"]}

    def get_record(self, hour, variable, level):
        record = self.describe(hour, variable, level)
        path, cache_meta = self.cache.fetch(record["source_url"], byte_range=record["byte_range"],
                                           max_bytes=RECORD_LIMIT, require_grib=True)
        return path, {**record, "sha256": cache_meta["sha256"], "retrieved_at": cache_meta["retrieved_at"]}

    def preflight(self, schedule, *, require_cached=False):
        records = []
        for hour in schedule["layer_hours"]:
            for variable, level in (("LCDC", "low cloud layer"), ("MCDC", "middle cloud layer"), ("HCDC", "high cloud layer")):
                records.append(self.describe(hour, variable, level))
        for hour in schedule["wind_hours"]:
            for variable in ("UGRD", "VGRD"):
                for pressure in (850, 500, 250):
                    records.append(self.describe(hour, variable, pressure))
        for hour in schedule["profile_hours"]:
            for variable in ("HGT", "TMP", "TCDC", "CLMR", "ICMR"):
                for pressure in (1000, 925, 850, 700, 500, 350, 250, 150):
                    records.append(self.describe(hour, variable, pressure))
        cached = [self.cache.cached(r["source_url"], r["byte_range"]) is not None for r in records]
        if require_cached and not all(cached):
            raise ValueError(f"Offline NOAA cache has {sum(cached)}/{len(records)} required GRIB records; no conversion started")
        return {"provider": self.spec["id"], "data_kind": self.spec["data_kind"], "source_mode": "forecast",
                "initialization": self.initialization.isoformat(), "source_grid_degrees": self.spec["grid_degrees"],
                "required_records": len(records), "cached_records": sum(cached),
                "grib_bytes": sum(r["bytes"] for r in records),
                "uncached_grib_bytes": sum(r["bytes"] for r, hit in zip(records, cached) if not hit),
                "records": records}

    def source_metadata(self):
        note = ("Archived GFS forecast model output, not observations or reanalysis. "
                "Archive states are three-hourly; intermediate motion is reconstructed. " if self.spec["data_kind"] == "archived_forecast"
                else "GFS forecast model output, not observations. ")
        note += ("0.5° cloud coverage is bilinearly resampled to the renderer's 0.25° grid; no finer observed detail is added."
                 if self.spec["grid_degrees"] == .5 else "Native 0.25° layer cover; pressure fields sampled on a 0.5° grid.")
        return {"source_mode": "forecast", "data_kind": self.spec["data_kind"], "archive_provider": self.spec["id"],
                "source_grid_degrees": self.spec["grid_degrees"], "provider": {
                    "url": self.spec["directory"], "credit": "NOAA NCEI / NCEP Global Forecast System",
                    "license_url": self.spec["documentation_url"], "notes": note}}
