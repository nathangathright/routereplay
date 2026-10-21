#!/usr/bin/env python3
"""Download/import portable asset bundles and verify their data contract.

Manifest and weather validation use the standard library. Bootstrap additionally
uses Pillow for the two derived textures; no renderer is imported by this CLI.
"""
from __future__ import annotations

import argparse
import ast
import calendar
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import tempfile
from urllib.request import Request, urlopen
from zipfile import ZipFile

SCHEMA_VERSION = 1
NASA_LICENSE = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
TERRAIN_URL = ("https://coastwatch.pfeg.noaa.gov/erddap/griddap/"
               "ETOPO_2022_v1_15s.nc?z%5B0:20:43199%5D%5B0:20:86399%5D")
LAND_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            "master/geojson/ne_50m_land.geojson")
NIGHTLIGHT_URL = ("https://assets.science.nasa.gov/content/dam/science/esd/eo/"
                  "images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg")
STAR_URL = "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz"
GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/"
WEATHER_MODES = {"clear", "forecast", "historical", "illustrative_replay", "itinerary_forecast"}


def utc(value):
    """Parse an aware ISO timestamp, rejecting timezone-free input."""
    value = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("An explicit UTC offset is required for data timestamps")
    return value.astimezone(timezone.utc)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_root(path):
    path = Path(path).expanduser().resolve()
    return path.parent if path.name == "bundle.json" else path


def safe_path(root, relative):
    if not isinstance(relative, str) or "\\" in relative:
        raise ValueError(f"Bundle path must be relative POSIX text: {relative!r}")
    part = PurePosixPath(relative)
    if part.is_absolute() or not part.parts or any(p in ("..", ".") for p in part.parts):
        raise ValueError(f"Unsafe bundle path: {relative!r}")
    root = Path(root).resolve()
    result = (root / part).resolve()
    if not result.is_relative_to(root):
        raise ValueError(f"Bundle path leaves its directory: {relative!r}")
    return result


def static_specs(month):
    if type(month) is not int or not 1 <= month <= 12:
        raise ValueError("Surface month must be an integer from 1 through 12")
    filename = f"world.2004{month:02d}.3x5400x2700.jpg"
    surface_url = ("https://assets.science.nasa.gov/content/dam/science/esd/eo/images/"
                   f"bmng/bmng-base/{calendar.month_name[month].lower()}/{filename}")
    return {
        "land_mask": {"path": "map.png", "source": {
            "url": LAND_URL, "credit": "Natural Earth, 1:50m land polygons",
            "license_url": "https://www.naturalearthdata.com/about/terms-of-use/",
            "notes": "Natural Earth public-domain data; RGB mask rasterized locally at 8192×4096."}},
        "terrain": {"path": "etopo-2022-5min.nc", "source": {
            "url": TERRAIN_URL, "credit": "NOAA NCEI, ETOPO 2022",
            "license_url": "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
            "notes": "5 arc-minute stride of ETOPO 2022; source NetCDF includes its reuse notice. Not current terrain."}},
        "surface": {"path": f"surface/{filename}", "source": {
            "url": surface_url, "credit": "NASA Earth Observatory, Reto Stöckli and Robert Simmon",
            "license_url": NASA_LICENSE,
            "notes": f"Historical 2004-{month:02d} seasonal composite. Not imagery from the trip date."}},
        "nightlights": {"path": "nightlights/BlackMarble_2016_gray_8192.png", "source": {
            "url": NIGHTLIGHT_URL, "credit": "NASA Earth Observatory / Black Marble / VIIRS",
            "license_url": NASA_LICENSE,
            "notes": "2016 annual display composite; grayscale Lanczos 8192×4096. Not calibrated radiance or measured lamp color."}},
        "stars": {"path": "stars/catalog.gz", "source": {
            "url": STAR_URL, "credit": "Hoffleit and Warren (1991), Bright Star Catalogue V/50, CDS",
            "license_url": "https://cdsarc.cds.unistra.fr/ftp/V/50/ReadMe",
            "notes": "Retain catalogue citation and consult its data-provider terms; no blanket public-domain claim."}},
    }


def file_record(root, relative, source):
    path = safe_path(root, relative)
    if not path.is_file():
        raise ValueError(f"Missing asset: {relative}")
    return {"path": relative, "bytes": path.stat().st_size, "sha256": sha256(path), "source": source}


def _check_record(root, record, verify_hashes):
    if not isinstance(record, dict):
        raise ValueError("Asset records must be objects")
    path = safe_path(root, record.get("path"))
    if not path.is_file():
        raise ValueError(f"Missing asset: {record['path']}")
    if type(record.get("bytes")) is not int or record["bytes"] <= 0 or path.stat().st_size != record["bytes"]:
        raise ValueError(f"Asset size changed: {record['path']}")
    if not isinstance(record.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
        raise ValueError(f"Invalid SHA256: {record['path']}")
    if verify_hashes and sha256(path) != record["sha256"]:
        raise ValueError(f"Asset hash changed: {record['path']}")
    source = record.get("source", {})
    if not isinstance(source, dict) or not all(isinstance(source.get(k), str) and source[k] for k in ("url", "credit", "license_url", "notes")):
        raise ValueError(f"Incomplete source provenance: {record['path']}")


def _hours(values, name):
    if (not isinstance(values, list) or len(values) < 2 or
            any(type(x) is not int or x < 0 for x in values) or
            any(b <= a for a, b in zip(values, values[1:]))):
        raise ValueError(f"{name} must contain at least two increasing nonnegative integer forecast hours")
    return values


def _npy_header(handle):
    """Read small NPY metadata without importing NumPy or loading field arrays."""
    if handle.read(6) != b"\x93NUMPY":
        raise ValueError("Invalid NPY array")
    version = handle.read(2)
    size_format = "<H" if version == b"\x01\x00" else "<I" if version in (b"\x02\x00", b"\x03\x00") else None
    if size_format is None:
        raise ValueError("Unsupported NPY version")
    size = struct.unpack(size_format, handle.read(struct.calcsize(size_format)))[0]
    if size > 65536:
        raise ValueError("Unreasonably large NPY header")
    return ast.literal_eval(handle.read(size).decode("utf-8" if version[0] == 3 else "latin1").strip())


def _npz_info(path, timestamp_key="timestamps", expected_shapes=None):
    with ZipFile(path) as archive:
        if expected_shapes:
            for name, shape in expected_shapes.items():
                with archive.open(name + ".npy") as handle:
                    header = _npy_header(handle)
                    if header.get("shape") != shape or "O" in header.get("descr", "O"):
                        raise ValueError(f"Unexpected {name} shape/dtype in {path.name}")
                    numeric = re.fullmatch(r"[<>|=][fiu]([1248])", header.get("descr", ""))
                    if not numeric or archive.getinfo(name + ".npy").file_size != handle.tell() + math.prod(shape) * int(numeric[1]):
                        raise ValueError(f"Invalid {name} payload size/dtype in {path.name}")
        with archive.open(timestamp_key + ".npy") as handle:
            header = _npy_header(handle)
            descr = header["descr"]
            if descr not in ("<f8", ">f8", "<f4", ">f4") or header.get("fortran_order"):
                raise ValueError(f"Expected plain float timestamps in {path.name}")
            shape = header["shape"]
            if len(shape) > 1 or (shape and (not 1 <= shape[0] <= 10000)):
                raise ValueError(f"Invalid timestamps shape in {path.name}")
            count = shape[0] if shape else 1
            fmt = descr[0] + ("d" if descr[-1] == "8" else "f") * count
            raw = handle.read(struct.calcsize(fmt) + 1)
            if len(raw) != struct.calcsize(fmt):
                raise ValueError(f"Invalid timestamp payload in {path.name}")
            return list(struct.unpack(fmt, raw))


def weather_contract(root, source_mode="forecast"):
    """Validate converted GFS arrays against their metadata and return runtime."""
    if source_mode not in ("forecast", "historical"):
        raise ValueError("Weather source_mode must be forecast or historical")
    root = Path(root)
    layers = json.loads((root / "cloud-layers-source.json").read_text())
    profiles = json.loads((root / "cloud-profile-source.json").read_text())
    if (layers.get("source_mode", "forecast") != source_mode or
            profiles.get("source_mode", "forecast") != source_mode):
        raise ValueError("Requested source mode differs from the provider metadata; do not relabel forecast data as historical")
    if layers.get("model") != profiles.get("model") or not layers.get("model"):
        raise ValueError("Weather component model names differ or are missing")
    init = utc(layers["initialization"])
    if utc(profiles["initialization"]) != init:
        raise ValueError("Layer and profile initializations differ")
    layer_hours = _hours(layers["forecast_hours"], "layer_hours")
    wind_hours = _hours(profiles["wind_forecast_hours"], "wind_hours")
    profile_hours = _hours(profiles["profile_forecast_hours"], "profile_hours")
    expected = lambda hours: [(init + timedelta(hours=h)).timestamp() for h in hours]
    layer_times = _npz_info(root / "cloud-layers.npz", expected_shapes={
        "coverage": (len(layer_hours), 3, 721, 1440)})
    wind_times = _npz_info(root / "cloud-winds.npz", expected_shapes={
        "u": (len(wind_hours), 3, 361, 720), "v": (len(wind_hours), 3, 361, 720),
        "representative_heights_m": (3,)})
    if _npz_info(root / "cloud-winds.npz", "representative_heights_m") != [1500.0, 5500.0, 10500.0]:
        raise ValueError("Wind height planes differ from the renderer's supported convention")
    if layer_times != expected(layer_hours) or wind_times != expected(wind_hours):
        raise ValueError("Weather metadata and NPZ timestamps disagree")
    profile_shapes = {k: (17, 361, 720) for k in ("extinction", "coverage", "ice_fraction", "tau_above")}
    profile_shapes.update({k: (3, 361, 720) for k in ("column_tau", "column_height")})
    profile_shapes["altitudes_m"] = (17,)
    for hour, stamp in zip(profile_hours, expected(profile_hours)):
        profile = root / f"cloud-profile-f{hour:03d}.npz"
        if _npz_info(profile, "timestamp", profile_shapes) != [stamp]:
            raise ValueError(f"Profile f{hour:03d} timestamp disagrees with initialization")
        if _npz_info(profile, "altitudes_m") != list(range(0, 16001, 1000)):
            raise ValueError("Profile height planes differ from the renderer's supported convention")
    start = max(layer_hours[0], wind_hours[0], profile_hours[0])
    end = min(layer_hours[-1], wind_hours[-1], profile_hours[-1])
    if start >= end:
        raise ValueError("Weather components have no shared time interval")
    return {"schema_version": SCHEMA_VERSION, "model": layers["model"], "source_mode": source_mode,
            "initialization": init.isoformat(), "layer_hours": layer_hours, "wind_hours": wind_hours,
            "profile_hours": profile_hours, "valid_start": (init + timedelta(hours=start)).isoformat(),
            "valid_end": (init + timedelta(hours=end)).isoformat()}


def _weather_files(runtime):
    return ["weather/cloud-layers.npz", "weather/cloud-winds.npz",
            "weather/cloud-layers-source.json", "weather/cloud-profile-source.json",
            "weather/runtime.json"] + [f"weather/cloud-profile-f{h:03d}.npz" for h in runtime["profile_hours"]]


def read_bundle(path, verify_hashes=True):
    """Read a complete v1 manifest, verifying relative paths and asset integrity.

    Workers may skip hashes and tile array validation after a full preflight.
    File sizes, paths, provenance and weather metadata are still checked.
    """
    root = bundle_root(path)
    bundle = json.loads((root / "bundle.json").read_text())
    if bundle.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported bundle schema_version")
    specs = static_specs(bundle.get("surface_month"))
    assets = bundle.get("assets")
    if not isinstance(assets, dict) or set(assets) != set(specs):
        raise ValueError("Bundle must contain land_mask, terrain, surface, nightlights and stars")
    for name, spec in specs.items():
        _check_record(root, assets[name], verify_hashes)
        if assets[name]["path"] != spec["path"]:
            raise ValueError(f"Unexpected path for {name}: {assets[name]['path']}")
    environment = bundle.get('environment', {})
    if not isinstance(environment,dict) or set(environment)-{'aerosol','surface_conditions'}:
        raise ValueError('environment must map aerosol and/or surface_conditions to local products')
    for kind,record in environment.items():
        _check_record(root,record,verify_hashes)
        if record['path'] != 'environment/'+record['sha256']+'.npz':
            raise ValueError('Environment products need content-addressed environment/*.npz paths')
        from environmental_data import environment_metadata
        metadata=environment_metadata(safe_path(root,record['path']))
        if metadata['kind'] != kind or metadata['source'] != record['source']:
            raise ValueError('Environment product kind/source differs from its bundle record')
    calibration=bundle.get('calibration')
    if calibration is not None:
        _check_record(root,calibration,verify_hashes)
        if calibration['path'] != 'calibration/'+calibration['sha256']+'.json':
            raise ValueError('Calibration needs a content-addressed calibration/*.json path')
        from calibration import read_profile
        profile=read_profile(safe_path(root,calibration['path']))
        if profile['source'] != calibration['source']:
            raise ValueError('Calibration source differs from its bundle record')
    lighting = bundle.get('lighting_profile')
    if lighting is not None:
        _check_record(root, lighting, verify_hashes)
        if lighting['path'] != 'lighting/' + lighting['sha256'] + '.json':
            raise ValueError('Lighting profile must use its content-addressed lighting/*.json path')
        from lighting_profile import read_profile
        profile = read_profile(safe_path(root, lighting['path']))
        if profile['source'] != lighting['source']:
            raise ValueError('Lighting profile source disagrees with its bundle record')
    models = bundle.get('aircraft_models', {})
    from trip import SUPPORTED_AIRCRAFT
    if not isinstance(models, dict) or not set(models).issubset(SUPPORTED_AIRCRAFT):
        raise ValueError('aircraft_models must map supported aircraft types to GLB records')
    for record in models.values():
        _check_record(root, record, verify_hashes)
        if record['path'] != 'aircraft-models/' + record['sha256'] + '.glb':
            raise ValueError('Aircraft model must use its content-addressed aircraft-models/*.glb path')
        from aircraft_assets import validate_aircraft_model, validate_model_metadata
        validate_model_metadata(record)
        if verify_hashes:
            validate_aircraft_model(safe_path(root, record['path']), record)
    tiles=bundle.get("terrain_tiles",[])
    if not isinstance(tiles,list) or len(tiles)>32:
        raise ValueError("terrain_tiles must be a list of at most 32 local DEM assets")
    paths=[]
    for record in tiles:
        _check_record(root,record,verify_hashes)
        relative=record['path']
        if not relative.startswith('terrain-tiles/') or not relative.endswith('.npz') or relative in paths:
            raise ValueError('Terrain tiles need unique terrain-tiles/*.npz paths')
        paths.append(relative)
    if paths:
        from terrain_tiles import check_tile_budget, read_tile
        tile_paths=[safe_path(root,relative) for relative in paths]
        check_tile_budget(tile_paths)
        if verify_hashes:
            # Check the entire budget first, then decompress one tile at a time.
            for tile_path in tile_paths:
                read_tile(tile_path)
    weather = bundle.get("weather")
    if weather is not None:
        if not isinstance(weather, dict) or weather.get("runtime_path") != "weather/runtime.json":
            raise ValueError("Invalid weather runtime path")
        files = weather.get("files", [])
        if {r.get("path") for r in files} != set(_weather_files(weather)) or len(files) != len(_weather_files(weather)):
            raise ValueError("Weather manifest does not list the complete converted dataset")
        for record in files:
            _check_record(root, record, verify_hashes)
        actual = weather_contract(root / "weather", weather.get("source_mode"))
        runtime = json.loads((root / "weather/runtime.json").read_text())
        if runtime != actual or any(weather.get(k) != v for k, v in actual.items()):
            raise ValueError("Weather runtime/manifest differs from its actual data")
    return bundle


def validate_bundle(path, weather_mode, start_dt, end_dt, month, verify_hashes=True):
    """Reject unavailable weather or mismatched seasons before rendering any frame.

    start_dt/end_dt must be the trip's *weather clock*, including animated holds.
    In illustrative_replay these are explicitly mapped sample times, not flight
    timestamps. A cached forecast remains a forecast, even after its valid date.
    """
    if weather_mode not in WEATHER_MODES:
        raise ValueError(f"Unknown weather mode: {weather_mode}")
    start, end = utc(start_dt), utc(end_dt)
    if end < start:
        raise ValueError("Weather end precedes start")
    bundle = read_bundle(path, verify_hashes=verify_hashes)
    if bundle["surface_month"] != month:
        raise ValueError(f"Bundle surface month {bundle['surface_month']} differs from requested {month}")
    for record in bundle.get('environment',{}).values():
        from environmental_data import validate_environment_coverage
        validate_environment_coverage(safe_path(bundle_root(path),record['path']),start,end)
    if weather_mode == "clear":
        return bundle
    weather = bundle.get("weather")
    if not weather:
        raise ValueError("Weather requested but the bundle has no weather data; supply data or explicitly choose clear")
    required = "forecast" if weather_mode == "itinerary_forecast" else weather_mode
    if required != "illustrative_replay" and weather["source_mode"] != required:
        raise ValueError(f"Requested {required} but supplied data is {weather['source_mode']}")
    first, last = utc(weather["valid_start"]), utc(weather["valid_end"])
    if start < first or end > last:
        raise ValueError(f"Weather covers {first.isoformat()} through {last.isoformat()}, "
                         f"not requested {start.isoformat()} through {end.isoformat()}; no clamping or date substitution")
    return bundle


def bundle_fingerprint(bundle):
    """Content identity excludes retrieval timestamps and local absolute paths."""
    records = list(bundle["assets"].values()) + (bundle.get("weather") or {}).get("files", []) + bundle.get("terrain_tiles",[])
    records += list(bundle.get('aircraft_models', {}).values())
    records += list(bundle.get('environment', {}).values())
    if bundle.get('lighting_profile'):
        records.append(bundle['lighting_profile'])
    if bundle.get('calibration'):
        records.append(bundle['calibration'])
    payload = {"schema_version": bundle["schema_version"], "surface_month": bundle["surface_month"],
               "files": sorted((r["path"], r["sha256"]) for r in records),
               "aircraft_models": bundle.get('aircraft_models', {})}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def attach_weather(destination, source, source_mode="forecast"):
    """Copy a converted dataset into a static bundle; raw GRIB is not required."""
    destination, source = bundle_root(destination), Path(source).resolve()
    bundle = read_bundle(destination)
    runtime = weather_contract(source, source_mode)
    init = utc(runtime["initialization"])
    supplied = json.loads((source/'cloud-layers-source.json').read_text()).get('provider')
    if supplied is not None:
        if not isinstance(supplied, dict) or not all(isinstance(supplied.get(k), str) and supplied[k]
                for k in ('url', 'credit', 'license_url', 'notes')):
            raise ValueError('Weather provider needs url, credit, license_url and notes')
        origin = supplied
    elif runtime['model'] == 'NOAA GFS':
        origin = {"url": f"{GFS_BASE}gfs.{init:%Y%m%d}/{init:%H}/atmos/", "credit": "NOAA/NCEP Global Forecast System",
                  "license_url": "https://www.weather.gov/disclaimer",
                  "notes": "Converted model fields; source record URLs and byte ranges retained in adjacent source JSON. "
                           "Cloud volume and sub-frame movement are reconstructed, not direct cloud observations."}
    else:
        origin = json.loads((source/'cloud-layers-source.json').read_text()).get('provider', {})
        if not all(isinstance(origin.get(k), str) and origin[k] for k in ('url', 'credit', 'license_url', 'notes')):
            raise ValueError('A custom weather provider needs url, credit, license_url and notes in source metadata provider')
    # Stage the replacement before touching the usable bundle. Failed downloads
    # or copies must not leave its old manifest pointing at changed fields.
    with tempfile.TemporaryDirectory(prefix='.weather-', dir=destination.parent) as scratch:
        staging = Path(scratch)
        staged_weather = staging/'weather'
        staged_weather.mkdir()
        for relative in _weather_files(runtime):
            if relative != 'weather/runtime.json':
                shutil.copyfile(source/Path(relative).name, staged_weather/Path(relative).name)
        write_json(staged_weather/'runtime.json', runtime)
        bundle['weather'] = {**runtime, 'runtime_path': 'weather/runtime.json',
                             'files': [file_record(staging,p,origin) for p in _weather_files(runtime)]}
        target, backup = destination/'weather', staging/'previous'
        if target.exists():
            target.rename(backup)
        try:
            staged_weather.rename(target)
            write_json(destination/'bundle.json',bundle)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            if backup.exists():
                backup.rename(target)
            raise
    return read_bundle(destination)


def import_bundle(source, destination, month, with_weather=False, source_mode="forecast"):
    """Import only reusable data, excluding flight evidence and aircraft caches."""
    source, destination = Path(source).resolve(), bundle_root(destination)
    if source == destination:
        raise ValueError("Import destination must differ from its source")
    if (destination / "bundle.json").exists():
        raise ValueError("Destination already has a bundle; use a new directory")
    specs = static_specs(month)
    for spec in specs.values():
        if not safe_path(source, spec["path"]).is_file():
            raise ValueError(f"Missing source asset: {spec['path']}")
    if with_weather:
        weather_contract(source / "weather", source_mode)
    destination.mkdir(parents=True, exist_ok=True)
    for spec in specs.values():
        path = safe_path(destination, spec["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(safe_path(source, spec["path"]), path)
    bundle = {"schema_version": SCHEMA_VERSION, "surface_month": month,
              "created_at": datetime.now(timezone.utc).isoformat(),
              "assets": {name: file_record(destination, spec["path"], spec["source"]) for name, spec in specs.items()},
              "weather": None}
    write_json(destination / "bundle.json", bundle)
    return attach_weather(destination, source / "weather", source_mode) if with_weather else read_bundle(destination)


def download(url, destination, max_bytes=100_000_000):
    """Bound download size and publish only complete HTTP bodies."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        request = Request(url, headers={"User-Agent": "cinematic-flight-videos/1 asset-bootstrap"})
        with urlopen(request, timeout=60) as response, temporary.open("wb") as handle:
            if response.status != 200:
                raise ValueError(f"Expected HTTP 200 downloading {url}")
            length = response.headers.get("Content-Length")
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > max_bytes:
                    raise ValueError(f"Download exceeds {max_bytes} bytes: {url}")
                handle.write(chunk)
            if not count or (length and count != int(length)):
                raise ValueError(f"Incomplete download: {url}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def bootstrap(destination, month):
    """Fetch static public sources, build textures, and record the obtained hashes."""
    from PIL import Image, ImageDraw

    destination = bundle_root(destination)
    if (destination / "bundle.json").exists():
        raise ValueError("Destination already has a bundle; choose a new directory")
    specs = static_specs(month)
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="flight-data-") as work:
        work = Path(work)
        for name in ("terrain", "surface", "stars"):
            spec = specs[name]
            print(f"Downloading {name}", flush=True)
            download(spec["source"]["url"], safe_path(destination, spec["path"]))
        terrain = safe_path(destination, specs["terrain"]["path"])
        with terrain.open("rb") as handle:
            if handle.read(4) not in (b"CDF\x01", b"CDF\x02"):
                raise ValueError("ETOPO response is not classic NetCDF; no fallback terrain was substituted")
        with Image.open(safe_path(destination, specs["surface"]["path"])) as surface:
            if surface.size != (5400, 2700):
                raise ValueError("Unexpected NASA surface dimensions")
            surface.verify()
        with gzip.open(safe_path(destination, specs["stars"]["path"]), "rt", encoding="ascii") as catalog:
            if sum(1 for _ in catalog) != 9110:
                raise ValueError("Unexpected Bright Star Catalogue record count")
        print("Downloading nightlights and coastline", flush=True)
        download(NIGHTLIGHT_URL, work / "lights.jpg")
        download(LAND_URL, work / "land.geojson", max_bytes=20_000_000)
        with Image.open(work / "lights.jpg") as lights:
            if lights.size != (13500, 6750):
                raise ValueError("Unexpected NASA night-light dimensions")
            path = safe_path(destination, specs["nightlights"]["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            lights.convert("L").resize((8192, 4096), Image.Resampling.LANCZOS).save(path)
        width, height = 8192, 4096
        land, coast, grid = (Image.new("L", (width, height)) for _ in range(3))
        dl, dc, dg = (ImageDraw.Draw(p) for p in (land, coast, grid))
        for feature in json.loads((work / "land.geojson").read_text())["features"]:
            geometry = feature["geometry"]
            polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
            for polygon in polygons:
                for index, ring in enumerate(polygon):
                    points = [((lon + 180) / 360 * width, (90 - lat) / 180 * height) for lon, lat in ring]
                    dl.polygon(points, fill=255 if index == 0 else 0)
                    dc.line(points, fill=180, width=3)
        for lon in range(-180, 180, 20):
            x = (lon + 180) / 360 * width
            dg.line([(x, 0), (x, height)], fill=255, width=2)
        for lat in range(-80, 81, 20):
            y = (90 - lat) / 180 * height
            dg.line([(0, y), (width, y)], fill=255, width=2)
        Image.merge("RGB", (land, coast, grid)).save(destination / "map.png")
    bundle = {"schema_version": SCHEMA_VERSION, "surface_month": month,
              "created_at": datetime.now(timezone.utc).isoformat(),
              "assets": {name: file_record(destination, spec["path"], spec["source"]) for name, spec in specs.items()},
              "weather": None}
    write_json(destination / "bundle.json", bundle)
    return read_bundle(destination)


def attach_terrain_tile(bundle_path, tile_path, source):
    """Append an immutable content-addressed tile; publish its manifest last."""
    keys={'url','credit','license_url','notes'}
    if not isinstance(source,dict):
        raise ValueError('Terrain source JSON must be an object with url, credit, license_url and notes')
    unexpected=set(source)-keys
    if unexpected:
        raise ValueError('Unexpected terrain source key(s): '+', '.join(sorted(map(str,unexpected))))
    if not all(isinstance(source.get(k),str) and source[k].strip() for k in keys):
        raise ValueError('Terrain source JSON requires nonempty url, credit, license_url and notes strings')
    root=bundle_root(bundle_path)
    # Inspect existing records without loading arrays until the proposed total
    # (including the new tile) is known to fit the bundle's resource budget.
    bundle=read_bundle(root,verify_hashes=False)
    from terrain_tiles import check_tile_budget, read_tile
    records=bundle.setdefault('terrain_tiles',[])
    with tempfile.TemporaryDirectory(prefix='.terrain-stage-',dir=root) as work:
        staging=Path(work)/'tile.npz'
        shutil.copy2(tile_path,staging)
        # The source may change while copying. Validate and address the bytes
        # that will actually be published, never the original source path.
        digest=sha256(staging)
        relative='terrain-tiles/'+digest+'.npz'
        if any(record['path']==relative for record in records):
            return read_bundle(root)
        if len(records)>=32:
            raise ValueError('Bundle supports at most 32 terrain tiles')
        check_tile_budget([safe_path(root,record['path']) for record in records]+[staging])
        # Full integrity and array checks follow the aggregate budget check.
        read_bundle(root)
        read_tile(staging)
        record={'path':relative,'bytes':staging.stat().st_size,'sha256':digest,'source':source}
        target=safe_path(root,relative)
        target.parent.mkdir(exist_ok=True)
        existed=target.exists()
        if existed:
            if sha256(target)!=digest:
                raise ValueError('Existing content-addressed terrain tile has different bytes: '+relative)
        else:
            staging.replace(target)
    records.append(record)
    try:
        write_json(root/'bundle.json',bundle)
    except BaseException:
        if not existed:
            target.unlink(missing_ok=True)
        raise
    return read_bundle(root)


def _attach_local(destination, path, folder, suffix, max_bytes, validate, update):
    """Publish validated immutable local bytes, then atomically update metadata."""
    root = bundle_root(destination)
    bundle = read_bundle(root)
    path = Path(path)
    if path.stat().st_size > max_bytes:
        raise ValueError(f'Local {folder} asset exceeds its {max_bytes}-byte limit')
    with tempfile.TemporaryDirectory(prefix='.asset-stage-', dir=root) as temporary:
        staged = Path(temporary) / ('asset' + suffix)
        with path.open('rb') as source, staged.open('wb') as output:
            copied = 0
            while chunk := source.read(1024 * 1024):
                copied += len(chunk)
                if copied > max_bytes:
                    raise ValueError('Local asset grew beyond its size limit while copying')
                output.write(chunk)
        metadata = validate(staged)
        digest = sha256(staged)
        relative = f'{folder}/{digest}{suffix}'
        record = {'path': relative, 'bytes': copied, 'sha256': digest, **metadata}
        target = safe_path(root, relative)
        target.parent.mkdir(exist_ok=True)
        existed = target.exists()
        if existed and sha256(target) != digest:
            raise ValueError('Existing content-addressed local asset has different bytes')
        if not existed:
            staged.replace(target)
        update(bundle, record)
        try:
            write_json(root / 'bundle.json', bundle)
        except BaseException:
            if not existed:
                target.unlink(missing_ok=True)
            raise
    return read_bundle(root)


def attach_lighting_profile(destination, path):
    from lighting_profile import MAX_BYTES, read_profile
    return _attach_local(destination, path, 'lighting', '.json', MAX_BYTES,
        lambda staged: {'source': read_profile(staged)['source']},
        lambda bundle, record: bundle.update(lighting_profile=record))


def attach_calibration(destination,path):
    from calibration import MAX_BYTES,read_profile,profile_summary
    def validate(staged):
        profile=read_profile(staged)
        return {'source':profile['source'],**profile_summary(profile)}
    return _attach_local(destination,path,'calibration','.json',MAX_BYTES,validate,
        lambda bundle,record:bundle.update(calibration=record))


def attach_environment(destination, path):
    from environmental_data import MAX_FILE_BYTES, environment_metadata
    def validate(staged):
        metadata=environment_metadata(staged)
        return {'source':metadata['source'],'kind':metadata['kind'],
                'valid_start':metadata['valid_start'],'valid_end':metadata['valid_end']}
    return _attach_local(destination,path,'environment','.npz',MAX_FILE_BYTES,validate,
        lambda bundle,record:bundle.setdefault('environment',{}).__setitem__(record['kind'],record))


def attach_aircraft_model(destination, kind, path, metadata):
    from trip import SUPPORTED_AIRCRAFT
    from aircraft_assets import MAX_GLB_BYTES, validate_aircraft_model, validate_model_metadata
    if kind not in SUPPORTED_AIRCRAFT:
        raise ValueError('Select a supported aircraft type: ' + ', '.join(SUPPORTED_AIRCRAFT))
    metadata = validate_model_metadata(metadata)
    return _attach_local(destination, path, 'aircraft-models', '.glb', MAX_GLB_BYTES,
        lambda staged: validate_aircraft_model(staged, metadata),
        lambda bundle, record: bundle.setdefault('aircraft_models', {}).__setitem__(kind, record))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("bootstrap", help="Download reusable static data; no weather or aircraft caches")
    fetch.add_argument("--destination", required=True)
    fetch.add_argument("--month", type=int, required=True)
    imp = commands.add_parser("import-bundle", help="Copy a selected legacy assets directory into a portable bundle")
    imp.add_argument("--source", required=True)
    imp.add_argument("--destination", required=True)
    imp.add_argument("--month", type=int, required=True)
    imp.add_argument("--with-weather", action="store_true")
    imp.add_argument("--source-mode", choices=("forecast", "historical"), default="forecast")
    verify = commands.add_parser("verify", help="Check bundle paths, hashes and weather timestamp metadata")
    verify.add_argument("bundle")
    tile=commands.add_parser('attach-terrain',help='Attach a validated local MSL DEM tile with provenance')
    tile.add_argument('bundle')
    tile.add_argument('tile')
    tile.add_argument('--source-json',required=True,help='JSON with url, credit, license_url, notes')
    lighting = commands.add_parser('attach-lighting', help='Attach dated local lamp chromaticity and schedule evidence')
    lighting.add_argument('bundle')
    lighting.add_argument('profile')
    model = commands.add_parser('attach-aircraft', help='Attach a self-contained licensed local GLB for an aircraft type')
    model.add_argument('bundle')
    model.add_argument('kind')
    model.add_argument('model')
    model.add_argument('--metadata-json', required=True)
    calibration = commands.add_parser('attach-calibration',help='Attach attributed surveys and aircraft materials')
    calibration.add_argument('bundle')
    calibration.add_argument('profile')
    environment = commands.add_parser('attach-environment',help='Attach dated aerosol or snow/sea-ice fields')
    environment.add_argument('bundle')
    environment.add_argument('product')
    args = parser.parse_args()
    try:
        if args.command == "bootstrap":
            bundle = bootstrap(args.destination, args.month)
        elif args.command == "import-bundle":
            bundle = import_bundle(args.source, args.destination, args.month, args.with_weather, args.source_mode)
        elif args.command == 'attach-calibration':
            bundle=attach_calibration(args.bundle,args.profile)
        elif args.command == 'attach-environment':
            bundle=attach_environment(args.bundle,args.product)
        elif args.command == "attach-terrain":
            bundle=attach_terrain_tile(args.bundle,args.tile,json.loads(Path(args.source_json).read_text()))
        elif args.command == 'attach-lighting':
            bundle = attach_lighting_profile(args.bundle, args.profile)
        elif args.command == 'attach-aircraft':
            bundle = attach_aircraft_model(args.bundle, args.kind, args.model,
                                          json.loads(Path(args.metadata_json).read_text()))
        else:
            bundle = read_bundle(args.bundle)
    except (ValueError, OSError, KeyError, struct.error) as error:
        parser.exit(1, f"Asset bundle error: {error}\n")
    print(json.dumps({"valid": True, "fingerprint": bundle_fingerprint(bundle),
                      "surface_month": bundle["surface_month"], "weather": (bundle.get("weather") or {}).get("valid_start")}, indent=2))


if __name__ == "__main__":
    main()
