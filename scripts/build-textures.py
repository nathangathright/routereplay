#!/usr/bin/env python3
"""Build the versioned Earth texture set and asset manifest.

Sources are public-domain NASA images (the monthly Blue Marble: Next Generation base map
from NASA's own host, Black Marble 2016 through Wikimedia Commons), public-domain Natural Earth
outlines of land, islands, ice shelves, and lakes for the water mask, and NOAA's public-domain ETOPO 2022
elevation for the relief map (see docs/assets.md). Downloads are cached under .cache/textures; outputs go
to public/assets/<ASSET_MANIFEST_VERSION>/, read from src/shared/scene/constants.ts. Older version
directories are left untouched. Requires Pillow with WebP support, NumPy, and SciPy.

Usage: python3 -I scripts/build-textures.py [part ...]

With no parts, everything is built and the manifest rewritten. Naming parts (day, night, night-detail, water,
relief) builds only those and replaces their records in the existing manifest.
"""
import base64
import calendar
import functools
import hashlib
import json
import math
import pathlib
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.io import netcdf_file
from scipy.ndimage import uniform_filter1d

Image.MAX_IMAGE_PIXELS = None  # the Blue Marble sources are 21600x10800

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = re.search(
    r"ASSET_MANIFEST_VERSION = '([^']+)'", (ROOT / 'src' / 'shared' / 'scene' / 'constants.ts').read_text()
).group(1)
CACHE = ROOT / '.cache' / 'textures'
ASSETS = ROOT / 'public' / 'assets'
OUT = ASSETS / VERSION
UA = 'routereplay-web texture build script'

# Blue Marble: Next Generation base map, one 2004 composite per month, at 2 km per pixel. No shaded
# topography or bathymetry: the scene lights the ground itself, and bathymetry draws sea-floor features
# (fracture zones, shelf edges) that can't be seen from space. Matches the offline renderer's choice.
BMNG_PAGE = 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/'
BMNG_URL = (
    'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/'
    '{month_name}/world.2004{month:02d}.3x21600x10800.jpg'
)
BMNG_CREDIT = 'Reto Stöckli and Robert Simmon, NASA Earth Observatory (Blue Marble: Next Generation, 2004 monthly base map)'
# Day textures by width. The loader picks one per quality and device (src/app/render/assets.ts).
DAY_WIDTHS = (4096, 8192)
DAY_WEBP_QUALITY = 82

# NASA Black Marble 2016 at full resolution (43200x21600: 30 arc seconds, about 0.93 km per pixel; 279 MB), the
# source of the global night maps and the night-detail tiles. URL and SHA-1 from the Commons API
# (action=query&prop=imageinfo&iiprop=url|sha1). Decoding it takes about 4 GB of memory.
NIGHT = {
    'url': 'https://upload.wikimedia.org/wikipedia/commons/a/af/BlackMarble20161km.jpg',
    'page': 'https://commons.wikimedia.org/wiki/File:BlackMarble20161km.jpg',
    'sha1': '2f94891914481e85c80f1a9892886e4473a871b6',
    'credit': "NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA's Goddard Space Flight Center (Black Marble 2016)",
    'file': 'black-marble-2016-43200.jpg',
}
# Global night maps by quality: the light level averaged over 12 x 12 source pixels (standard) or about 21 x 21
# (low), one channel, lossless WebP.
NIGHT_SIZES = {'low': (2048, 1024), 'standard': (3600, 1800)}
# Night-detail tiles: 5-degree cells of the same light level (one channel), only for cells with any light, as
# lossless WebP. Each tile also holds NIGHT_DETAIL_GUTTER pixels of its neighbours on every side, so filtering is
# seamless across tile edges. Standard keeps the full resolution (600 + 2 x 4 pixels square); low averages 2 x 2
# (300 + 2 x 2). src/shared/scene/nightTiles.ts lists the cells that have a tile; nightDetail.ts mirrors the layout.
NIGHT_DETAIL_DEGREES = 5
NIGHT_DETAIL_GUTTER = 4
NIGHT_DETAIL_REDUCTION = {'standard': 1, 'low': 2}
NIGHT_TILES_MODULE = ROOT / 'src' / 'shared' / 'scene' / 'nightTiles.ts'

# Natural Earth 1:10m outlines (public domain), rasterized into the water mask for ocean glint and sky
# reflection. Minor islands and Antarctic ice shelves count as land: the day map shows both, and ice shelves
# are white there, not water. Lakes are cut back out.
NATURAL_EARTH_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_{}.geojson'
LAND_LAYERS = ('land', 'minor_islands', 'antarctic_ice_shelves_polys')
WATER_LAYERS = ('lakes',)
NATURAL_EARTH_PAGE = 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/'
# One mask per day texture width, texel for texel.
WATER_WIDTHS = DAY_WIDTHS

# NOAA ETOPO 2022 15 arc-second global relief (public domain), read through NOAA's ERDDAP server every 10th
# cell (2.5 arc minutes) in 18 bands of latitude. The offline renderer reads every 20th cell of the same grid.
ETOPO_PAGE = 'https://www.ncei.noaa.gov/products/etopo-global-relief-model'
ETOPO_DATASET = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.html'
ETOPO_URL = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc?z%5B{first}:10:{last}%5D%5B5:10:86399%5D'
ETOPO_CREDIT = 'NOAA National Centers for Environmental Information (ETOPO 2022 15 Arc-Second Global Relief Model)'
# Relief maps by quality. Each texel averages 2×2 or 4×4 samples: standard is the offline renderer's
# 5-arc-minute grid (9.3 km at the equator), low is half that.
RELIEF_SIZES = {'standard': (4320, 2160), 'low': (2160, 1080)}
# Heights exaggerated 12×, the offline renderer's relief_exaggeration. The map stores the tilted normal's east
# and north components as 128 + 127 × component (red, green), rounded to steps of 3: in low-Sun tests that
# looked the same as unrounded normals, and the file is a third smaller than with steps of 1.
RELIEF_EXAGGERATION = 12
RELIEF_STEP = 3
EARTH_RADIUS_M = 6371000.0

# Copied unchanged from the previous version directory.
CARRIED = ('Dosis-Variable.ttf', 'OFL.txt', 'BarlowCondensed-SemiBold.ttf', 'BarlowCondensed-OFL.txt')

NASA_LICENSE = 'Public domain (NASA)'


def fetch(url, name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f'Downloading {url}', file=sys.stderr)
        part = path.with_suffix(path.suffix + '.part')
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=300) as r, open(part, 'wb') as f:
            shutil.copyfileobj(r, f)
        part.rename(path)
    return path


def rings(geometry):
    """Yield (ring, is_hole) for a GeoJSON Polygon or MultiPolygon."""
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    for polygon in polygons:
        for i, ring in enumerate(polygon):
            yield ring, i > 0


def build_water_masks(files):
    """Equirectangular masks matching the day textures (west edge -180°, top +90°): 255 = water, 0 = land."""
    scale = 4  # draw at 4x the largest width; each texel is then the share of its 16 samples that is water
    w = max(WATER_WIDTHS) * scale
    h = w // 2
    land = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(land)

    def px(lon, lat):
        return ((lon + 180) / 360 * w, (90 - lat) / 180 * h)

    names = [(name, 255, 0) for name in LAND_LAYERS] + [(name, 0, 255) for name in WATER_LAYERS]
    for name, fill, hole_fill in names:
        path = fetch(NATURAL_EARTH_URL.format(name), f'ne_10m_{name}.geojson')
        for feature in json.loads(path.read_text())['features']:
            for ring, is_hole in rings(feature['geometry']):
                draw.polygon([px(lon, lat) for lon, lat in ring], fill=hole_fill if is_hole else fill)
    for width in WATER_WIDTHS:
        # Four levels place the coastline within a quarter texel once the GPU filters the mask, and flat sea and
        # land compress to almost nothing. Lossless WebP is about a fifth smaller than the same image as a PNG.
        water = Image.eval(land.reduce(w // width), lambda v: round((255 - v) / 85) * 85)
        out = OUT / f'earth-water-{width}.webp'
        water.save(out, 'WEBP', lossless=True, quality=100, method=6)
        files.append(record(
            out, kind='earth-water', width=width, height=width // 2,
            source=f'{NATURAL_EARTH_PAGE} (ne_10m_{", ne_10m_".join(LAND_LAYERS + WATER_LAYERS)})',
            credit='Made with Natural Earth', license='Public domain (Natural Earth)',
        ))


def etopo():
    """ETOPO 2022 every 10th cell, clamped at sea level: 4320 rows from the north, 8640 columns from -180°."""
    bands = []
    for band in range(18):
        first = 2400 * band + 5
        url = ETOPO_URL.format(first=first, last=first + 2390)
        for attempt in range(3):
            try:
                path = fetch(url, f'etopo2022-15s-step10-{band:02d}.nc')
                break
            except urllib.error.HTTPError as e:
                if e.code != 503 or attempt == 2:  # ERDDAP turns requests away now and then under load
                    raise
                time.sleep(30)
        with netcdf_file(path, mmap=False) as nc:
            bands.append(np.array(nc.variables['z'][:], np.float32))
    return np.maximum(np.concatenate(bands)[::-1], 0)  # ERDDAP's rows run south to north


def lake_mask(width, height):
    """Natural Earth 1:10m lakes, the water mask's, widened by a texel. ETOPO 2022 has the floors of some lakes
    (Baikal, the Great Lakes) rather than their surface, which would draw cliffs along their shores."""
    image = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(image)
    for feature in json.loads(fetch(NATURAL_EARTH_URL.format('lakes'), 'ne_10m_lakes.geojson').read_text())['features']:
        for ring, is_hole in rings(feature['geometry']):
            draw.polygon([((lon + 180) / 360 * width, (90 - lat) / 180 * height) for lon, lat in ring], fill=0 if is_hole else 255)
    return np.asarray(image.filter(ImageFilter.MaxFilter(3))) > 0


def relief_map(heights, lakes):
    """The ground's normal, with heights exaggerated, as RGB: east component in red, north in green."""
    rows = heights.shape[0]
    step = math.pi / rows  # radians per texel, along a meridian and along the equator
    lat = (0.5 - (np.arange(rows) + 0.5) / rows) * math.pi
    # Toward the poles a texel spans less ground east to west. Average each row over about one texel's
    # north-south length first, so slopes there aren't differences between nearly coincident points.
    width = 2 * np.floor(0.5 / np.cos(lat)).astype(int) + 1
    z = np.stack([uniform_filter1d(row, k, mode='wrap') for row, k in zip(heights, width)])
    north = np.gradient(z, axis=0) / (-EARTH_RADIUS_M * step)  # rows run north to south
    east = (np.roll(z, -1, axis=1) - np.roll(z, 1, axis=1)) / (2 * EARTH_RADIUS_M * step * np.cos(lat)[:, None])
    east, north = RELIEF_EXAGGERATION * east, RELIEF_EXAGGERATION * north
    length = np.sqrt(1 + east * east + north * north)

    def encode(component):
        return (128 + RELIEF_STEP * np.round(127 / RELIEF_STEP * np.where(lakes, 0, component))).astype(np.uint8)

    return np.dstack([encode(-east / length), encode(-north / length), np.zeros(heights.shape, np.uint8)])


def build_relief(files):
    samples = etopo()
    for quality, (w, h) in RELIEF_SIZES.items():
        n = samples.shape[1] // w
        heights = samples.reshape(h, n, w, n).mean(axis=(1, 3))
        out = OUT / f'earth-relief-{quality}.webp'
        Image.fromarray(relief_map(heights, lake_mask(w, h))).save(out, 'WEBP', lossless=True, quality=100, method=6)
        files.append(record(
            out, kind='earth-relief', quality=quality, width=w, height=h, exaggeration=RELIEF_EXAGGERATION,
            source=ETOPO_PAGE, url=ETOPO_DATASET, credit=ETOPO_CREDIT, license='Public domain (NOAA)',
        ))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record(path, **fields):
    return {'path': path.name, **fields, 'bytes': path.stat().st_size, 'sha256': sha256(path)}


def build_day(files):
    for month in range(1, 13):
        url = BMNG_URL.format(month_name=calendar.month_name[month].lower(), month=month)
        source = Image.open(fetch(url, f'bmng-base-2004{month:02d}-21600.jpg'))
        source.draft('RGB', (10800, 5400))  # decode at half scale: still wider than the largest output
        image = source.convert('RGB')
        for width in sorted(DAY_WIDTHS, reverse=True):
            image = image.resize((width, width // 2), Image.LANCZOS)
            out = OUT / f'earth-day-{month:02d}-{width}.webp'
            image.save(out, 'WEBP', quality=DAY_WEBP_QUALITY, method=6)
            files.append(record(
                out, kind='earth-day', month=month, width=width, height=width // 2,
                source=BMNG_PAGE, url=url, credit=BMNG_CREDIT, license=NASA_LICENSE,
            ))


def build_night(files):
    level = night_light_level()
    for quality, (w, h) in NIGHT_SIZES.items():
        out = OUT / f'earth-night-{quality}.webp'
        Image.fromarray(level).resize((w, h), Image.BOX).save(out, 'WEBP', lossless=True, quality=100, method=6)
        files.append(record(
            out, kind='earth-night', quality=quality, width=w, height=h,
            source=NIGHT['page'], url=NIGHT['url'], credit=NIGHT['credit'], license=NASA_LICENSE,
        ))


@functools.cache
def night_light_level():
    """How bright the city light in each pixel of the full-resolution Black Marble is, 0-255, rows from the north.
    It is proportional to the light emitted, so averaging it (the global maps, filtering, mipmaps) is correct.

    NASA drew the lights over a faint bluish moonlit land, dim orange through yellow to white as they brighten.
    Their brightness is the pixel's luma above the land under them: NASA's grayscale Black Marble, lights only,
    matches (luma - 0.114) / 0.886 within a few levels from dim orange to white. Faint lights are told from the
    land by their warmth, red less 0.55 x blue above 0.06, over 0.39. The lesser of the two counts, so the land
    drops out and every light brighter than that keeps its luma. The level is that gray value as it is; the offline
    renderer raises NASA's gray to the power 0.82, which lifts suburbs toward their city centres. Channels are the
    sRGB values decoded and re-encoded with a 2.2 power, which matches the stored values except near black, where
    the land threshold was tuned."""
    path = fetch(NIGHT['url'], NIGHT['file'])
    if hashlib.sha1(path.read_bytes()).hexdigest() != NIGHT['sha1']:
        sys.exit(f'{path} does not match the SHA-1 Commons lists; delete it to download it again')
    v = np.arange(256) / 255
    e = (np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4) ** (1 / 2.2)).astype(np.float32)
    r, g, b = e[:, None, None], e[None, :, None], e[None, None, :]
    warmth = (r - 0.55 * b - 0.06) / 0.39
    luma = (0.299 * r + 0.587 * g + 0.114 * b - 0.114) / 0.886
    lut = np.round(255 * np.clip(np.minimum(warmth, luma), 0, 1)).astype(np.uint8)  # [R, G, B]
    image = Image.open(path)
    width, height = image.size
    level = np.empty((height, width), np.uint8)
    band = 400
    for top in range(0, height, band):
        rgb = np.asarray(image.crop((0, top, width, top + band)))
        level[top:top + band] = lut[rgb[..., 0], rgb[..., 1], rgb[..., 2]]
    return level


def tile_name(row, col):
    """A cell's file name from its south-west corner, e.g. N50W005 (row counts 5-degree cells from 90°S, col from 180°W)."""
    lat = row * NIGHT_DETAIL_DEGREES - 90
    lon = col * NIGHT_DETAIL_DEGREES - 180
    return f"{'S' if lat < 0 else 'N'}{abs(lat):02d}{'W' if lon < 0 else 'E'}{abs(lon):03d}.webp"


def record_dir(path, **fields):
    """A manifest record for a directory of tiles: total bytes, and the SHA-256 of a `sha256sum`-style listing."""
    names = sorted(p.name for p in path.iterdir())
    listing = ''.join(f'{sha256(path / name)}  {name}\n' for name in names)
    return {
        'path': path.name, **fields, 'tiles': len(names),
        'bytes': sum((path / name).stat().st_size for name in names),
        'sha256': hashlib.sha256(listing.encode()).hexdigest(),
    }


def build_night_detail(files):
    level = night_light_level()
    n = level.shape[1] // (360 // NIGHT_DETAIL_DEGREES)  # pixels per cell side
    rows, cols = 180 // NIGHT_DETAIL_DEGREES, 360 // NIGHT_DETAIL_DEGREES
    g = NIGHT_DETAIL_GUTTER
    cells = [(row, col) for row in range(rows) for col in range(cols)
             if level[(rows - 1 - row) * n:(rows - row) * n, col * n:(col + 1) * n].any()]

    def tile(row, col, reduction):
        top, left = (rows - 1 - row) * n, col * n
        y = np.clip(np.arange(top - g, top + n + g), 0, level.shape[0] - 1)  # the poles repeat their edge row
        x = np.arange(left - g, left + n + g) % level.shape[1]  # longitude wraps
        t = level[np.ix_(y, x)]
        if reduction > 1:
            s = t.shape[0] // reduction
            t = np.round(t.reshape(s, reduction, s, reduction).mean(axis=(1, 3))).astype(np.uint8)
        return Image.fromarray(t)

    for quality, reduction in NIGHT_DETAIL_REDUCTION.items():
        out = OUT / f'earth-night-detail-{quality}'
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir()

        def write(cell):
            tile(*cell, reduction).save(out / tile_name(*cell), 'WEBP', lossless=True, quality=100, method=6)

        with ThreadPoolExecutor() as pool:  # the WebP encoder releases the GIL
            list(pool.map(write, cells))
        files.append(record_dir(
            out, kind='earth-night-detail', quality=quality, degrees=NIGHT_DETAIL_DEGREES,
            width=(n + 2 * g) // reduction, gutter=g // reduction,
            source=NIGHT['page'], url=NIGHT['url'], credit=NIGHT['credit'], license=NASA_LICENSE,
        ))

    bits = bytearray(rows * cols // 8)
    for row, col in cells:
        i = row * cols + col
        bits[i // 8] |= 1 << (i % 8)
    NIGHT_TILES_MODULE.write_text(
        f'// Generated by scripts/build-textures.py for asset directory {VERSION}; do not edit.\n\n'
        f'/**\n * Which {NIGHT_DETAIL_DEGREES}° cells have a night-detail tile (any city light at full resolution): one bit per cell,\n'
        f' * least significant first, cell = row × {cols} + column, rows from 90°S and columns from 180°W, in base64.\n'
        f' * {len(cells)} of {rows * cols} cells.\n */\n'
        f"export const NIGHT_TILE_CELLS = '{base64.b64encode(bits).decode()}';\n"
    )


def carry_forward():
    """Copy the fonts and their licenses from the newest older version directory, if this one lacks them."""
    older = sorted(p for p in ASSETS.iterdir() if p.is_dir() and p.name < VERSION)
    for name in CARRIED:
        if not (OUT / name).exists():
            if not older or not (older[-1] / name).exists():
                sys.exit(f'Missing {name}: no older asset directory has it')
            shutil.copy2(older[-1] / name, OUT / name)


BUILDERS = {
    'day': build_day,
    'night': build_night,
    'night-detail': build_night_detail,
    'water': build_water_masks,
    'relief': build_relief,
}


def main():
    parts = sys.argv[1:] or list(BUILDERS)
    unknown = [p for p in parts if p not in BUILDERS]
    if unknown:
        sys.exit(f'Unknown part {", ".join(unknown)}; choose from {", ".join(BUILDERS)}')
    OUT.mkdir(parents=True, exist_ok=True)
    carry_forward()
    files = []
    for part in parts:
        BUILDERS[part](files)
    files.append(record(
        OUT / 'Dosis-Variable.ttf', kind='font',
        source='https://github.com/google/fonts/tree/main/ofl/dosis',
        credit='The Dosis Project Authors', license='SIL Open Font License 1.1 (OFL.txt)',
    ))
    files.append(record(
        OUT / 'BarlowCondensed-SemiBold.ttf', kind='font',
        source='https://github.com/google/fonts/tree/main/ofl/barlowcondensed',
        credit='The Barlow Project Authors', license='SIL Open Font License 1.1 (BarlowCondensed-OFL.txt)',
    ))
    if sys.argv[1:]:
        # A partial build replaces its own records and keeps the rest, in place, less any whose file is gone.
        merged = {f['path']: f for f in json.loads((OUT / 'manifest.json').read_text())['files']}
        merged.update({f['path']: f for f in files})
        files = [f for f in merged.values() if (OUT / f['path']).exists()]
    manifest = {
        'version': VERSION,
        'note': (
            'Static assets for Route Replay Web. Day textures are monthly (earth-day-<month>-<width>.webp), '
            'with a water mask at each width (earth-water-<width>.webp). The night maps (earth-night-<quality>.webp) and '
            'night-detail tiles hold one channel, the city-light level. The tiles '
            '(earth-night-detail-<quality>/, one record per directory) cover 5-degree cells with city light; '
            'each record hashes a sha256sum-style listing of its tiles. The aircraft model is generated in code '
            '(src/app/render/Aircraft.tsx).'
        ),
        'files': files,
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    for f in files:
        size = f"{f['width']}x{f.get('height', f['width'])} " if 'width' in f else ''
        count = f"{f['tiles']} tiles, " if 'tiles' in f else ''
        print(f"{f['path']}: {size}{count}{f['bytes'] / 1024:.0f} KiB", file=sys.stderr)


if __name__ == '__main__':
    main()
