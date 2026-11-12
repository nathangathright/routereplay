#!/usr/bin/env python3
"""Build the versioned Earth texture set and asset manifest.

Sources are public-domain NASA images (the monthly Blue Marble: Next Generation base map
from NASA's own host, Black Marble 2016 through Wikimedia Commons) and public-domain
Natural Earth land and lake outlines for the water mask (see docs/assets.md). Downloads are
cached under .cache/textures; outputs go to public/assets/<ASSET_MANIFEST_VERSION>/, read
from src/shared/scene/constants.ts. Older version directories are left untouched. Requires
Pillow with WebP support.

Usage: python3 -I scripts/build-textures.py
"""
import calendar
import hashlib
import json
import pathlib
import re
import shutil
import sys
import urllib.request

from PIL import Image, ImageDraw

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

NIGHT = {
    'url': 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/af/BlackMarble20161km.jpg/3840px-BlackMarble20161km.jpg',
    'page': 'https://commons.wikimedia.org/wiki/File:BlackMarble20161km.jpg',
    'credit': "NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA's Goddard Space Flight Center (Black Marble 2016)",
    'file': 'black-marble-2016-3840.jpg',
}
NIGHT_VARIANTS = {
    'low': (2048, 1024, 82),
    'standard': (3600, 1800, 85),
}

# Natural Earth 1:50m land and lakes (public domain), rasterized into the ocean-glint mask.
NATURAL_EARTH = {
    'land': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
    'lakes': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
}
WATER_SIZE = (2048, 1024)

# Copied unchanged from the previous version directory.
CARRIED = ('Dosis-Variable.ttf', 'OFL.txt')

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


def build_water_mask(out):
    """Equirectangular mask matching the day texture (west edge -180°, top +90°): 255 = water, 0 = land."""
    scale = 4  # draw large, then downsample for smooth coastlines
    w, h = WATER_SIZE[0] * scale, WATER_SIZE[1] * scale
    land = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(land)

    def px(lon, lat):
        return ((lon + 180) / 360 * w, (90 - lat) / 180 * h)

    for name, fill, hole_fill in (('land', 255, 0), ('lakes', 0, 255)):
        path = fetch(NATURAL_EARTH[name], f'ne_50m_{name}.geojson')
        for feature in json.loads(path.read_text())['features']:
            for ring, is_hole in rings(feature['geometry']):
                draw.polygon([px(lon, lat) for lon, lat in ring], fill=hole_fill if is_hole else fill)
    # Four grey levels keep smooth coastlines once the GPU filters the texture, at under a third of the size.
    water = Image.eval(land.resize(WATER_SIZE, Image.LANCZOS), lambda v: round((255 - v) / 85) * 85)
    water.save(out, 'PNG', optimize=True)


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
    image = Image.open(fetch(NIGHT['url'], NIGHT['file'])).convert('RGB')
    for quality, (w, h, q) in NIGHT_VARIANTS.items():
        out = OUT / f'earth-night-{quality}.jpg'
        image.resize((w, h), Image.LANCZOS).save(out, 'JPEG', quality=q, optimize=True, progressive=True)
        files.append(record(
            out, kind='earth-night', quality=quality, width=w, height=h,
            source=NIGHT['page'], url=NIGHT['url'], credit=NIGHT['credit'], license=NASA_LICENSE,
        ))


def carry_forward():
    """Copy the font and its license from the newest older version directory, if this one lacks them."""
    older = sorted(p for p in ASSETS.iterdir() if p.is_dir() and p.name < VERSION)
    for name in CARRIED:
        if not (OUT / name).exists():
            if not older or not (older[-1] / name).exists():
                sys.exit(f'Missing {name}: no older asset directory has it')
            shutil.copy2(older[-1] / name, OUT / name)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    carry_forward()
    files = []
    build_day(files)
    build_night(files)
    water = OUT / 'earth-water.png'
    build_water_mask(water)
    files.append(record(
        water, kind='earth-water', width=WATER_SIZE[0], height=WATER_SIZE[1],
        source='https://www.naturalearthdata.com/downloads/50m-physical-vectors/ (ne_50m_land, ne_50m_lakes)',
        credit='Made with Natural Earth', license='Public domain (Natural Earth)',
    ))
    files.append(record(
        OUT / 'Dosis-Variable.ttf', kind='font',
        source='https://github.com/google/fonts/tree/main/ofl/dosis',
        credit='The Dosis Project Authors', license='SIL Open Font License 1.1 (OFL.txt)',
    ))
    manifest = {
        'version': VERSION,
        'note': (
            'Static assets for Route Replay Web. Day textures are monthly (earth-day-<month>-<width>.webp); '
            'the aircraft model is generated in code (src/app/render/Aircraft.tsx).'
        ),
        'files': files,
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    for f in files:
        size = f"{f['width']}x{f['height']} " if 'width' in f else ''
        print(f"{f['path']}: {size}{f['bytes'] / 1024:.0f} KiB", file=sys.stderr)


if __name__ == '__main__':
    main()
