"""A real, date-dependent celestial background for the inward-looking camera.

Positions: Yale Bright Star Catalogue V/50, propagated by ERFA (derived from
IAU SOFA).  Camera coordinates are geographic east, north, outward.  The sky
looks along -outward through the shared 70-degree horizontal perspective FOV.
Point sizes and brightness are intentionally exaggerated for phone playback,
while real positions, colors, and magnitude ordering are retained. This is
not calibrated photometry. No synthetic or randomly placed stars.
"""
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
import gzip
import math

import erfa
import numpy as np
from PIL import Image
from camera_geometry import focal_length, HORIZONTAL_FOV_DEGREES
from radiometry import srgb_to_linear, display_image

from runtime import ASSETS, TRIP
STAR_DIR = ASSETS / 'stars'
HORIZONTAL_FOV_DEG = HORIZONTAL_FOV_DEGREES
MAGNITUDE_LIMIT = 6.5
ARCSEC_RAD = np.pi / (180 * 3600)


def _number(value, default=0.0):
    return float(value) if value.strip() else default


def _star_color(bv):
    """Tasteful display colors from measured B-V; not spectral photometry."""
    # Color rendering is intentionally less saturated than the underlying
    # blackbody colors, preserving the graphic's restrained palette.
    anchors = np.array([-.4, 0., .3, .65, 1., 1.5, 2.])
    colors = np.array([[.67,.79,1.], [.79,.86,1.], [.91,.94,1.],
                       [1.,.97,.91], [1.,.87,.71], [1.,.73,.52],
                       [1.,.65,.43]])
    return np.array([np.interp(bv, anchors, colors[:, c]) for c in range(3)]).T


@lru_cache(maxsize=1)
def catalogue():
    """Return vectorized ICRS astrometry and catalog photometric information."""
    rows = []
    with gzip.open(STAR_DIR / 'catalog.gz', 'rt', encoding='ascii') as source:
        for line in source:
            if not line[75:90].strip() or not line[102:107].strip():
                continue  # 14 historically retained nonstellar records.
            magnitude = float(line[102:107])
            if magnitude > MAGNITUDE_LIMIT:
                continue
            ra = math.radians(15 * (float(line[75:77]) +
                 float(line[77:79])/60 + float(line[79:83])/3600))
            dec = math.radians((float(line[84:86]) +
                  float(line[86:88])/60 + float(line[88:90])/3600) *
                  (-1 if line[83] == '-' else 1))
            # BSC pmRA is mu_alpha*cos(dec); ERFA needs d(alpha)/dt.
            pm_ra = _number(line[148:154]) * ARCSEC_RAD / math.cos(dec)
            pm_dec = _number(line[154:160]) * ARCSEC_RAD
            parallax = max(0.0, _number(line[161:166]))
            radial_velocity = _number(line[166:170])
            color_index = _number(line[109:114], .3)
            rows.append((int(line[:4]), ra, dec, pm_ra, pm_dec,
                         parallax, radial_velocity, magnitude, color_index))
    stars = np.array(rows)
    # Catalog is FK5 J2000.0. fk52h applies both frame orientation and spin
    # into the Hipparcos realization of ICRS, retaining epoch J2000.0.
    astrometry = erfa.fk52h(*(stars[:, i] for i in range(1, 7)))
    return {
        'hr': stars[:, 0].astype(int),
        'astrometry': astrometry,
        'magnitude': stars[:, 7],
        'color': srgb_to_linear(_star_color(stars[:, 8])),
        'catalog_ra_dec': stars[:, 1:3],
    }


def _time_scales(dt):
    if dt.tzinfo is None:
        raise ValueError('Star timestamps must be timezone-aware.')
    dt = dt.astimezone(timezone.utc)
    utc1, utc2 = erfa.dtf2d('UTC', dt.year, dt.month, dt.day, dt.hour,
                          dt.minute, dt.second + dt.microsecond/1e6)
    tai1, tai2 = erfa.utctai(utc1, utc2)
    tt1, tt2 = erfa.taitt(tai1, tai2)
    # UT1-UTC and polar motion are intentionally omitted: their error is
    # well below a pixel. TT is substituted for TDB (<2ms discrepancy).
    ut11, ut12 = erfa.utcut1(utc1, utc2, 0.0)
    return tt1, tt2, ut11, ut12


def earth_fixed_star_vectors(dt):
    """Apparent geocentric star directions in Earth-fixed geographic xyz."""
    tt1, tt2, ut11, ut12 = _time_scales(dt)
    astrom, _ = erfa.apci13(tt1, tt2)
    ra, dec = erfa.atciq(*catalogue()['astrometry'], astrom)
    # CIRS right ascension uses the CIO, so use ERA (not GAST) here.
    earth_rotation = erfa.era00(ut11, ut12)
    longitude = ra - earth_rotation
    cos_dec = np.cos(dec)
    return np.column_stack((cos_dec*np.cos(longitude),
                            cos_dec*np.sin(longitude), np.sin(dec)))


def project_star_vectors(vectors, bs, size=(1080, 1920), center=(540, 960)):
    """Perspective sky projection; negative camera depths are behind us."""
    east, north, outward = np.asarray(bs, dtype=float)
    focal = focal_length(size[0])
    depth = vectors @ -outward
    safe = np.where(np.abs(depth) < 1e-12, 1e-12, depth)
    x = center[0] + focal*(vectors @ east)/safe
    y = center[1] - focal*(vectors @ north)/safe
    return np.column_stack((x, y, depth))


@lru_cache(maxsize=4)
def _background(size, center):
    width, height = size
    yy, xx = np.ogrid[:height, :width]
    # A tiny lifted black level for video encoders; no decorative stars.
    lift = np.exp(-((xx-center[0])**2+(yy-center[1])**2)/(1.15*width)**2)
    sky = np.empty((height, width, 3), dtype=np.float32)
    for channel, (floor, gain) in enumerate(zip((2, 5, 10), (1, 2, 3))):
        sky[:, :, channel] = floor + gain*lift
    linear = srgb_to_linear(sky / 255)
    linear.setflags(write=False)
    return linear


def star_radiance(bs, dt, radius, size=(1080, 1920), center=(540, 960), *, visibility=1.0):
    """Return unclipped scene-linear RGB for shared exposure and compositing.

    radius only culls stars hidden safely inside the solid Earth silhouette.
    Gaussian point profiles remain stable as the camera tracks the route.
    Enlarged points and compressed brightness deliberately improve legibility
    in 360px-wide playback. ``visibility`` is an explicit artistic stellar gain;
    it affects stellar light, never the background lift or foreground graphics.
    """
    size, center = tuple(size), tuple(center)
    width, height = size
    visibility = max(0., float(visibility))
    display_scale = width / 1080
    sky = _background(size, center).copy()
    stars = catalogue()
    projected = project_star_vectors(earth_fixed_star_vectors(dt), bs, size, center)
    x, y, depth = projected.T
    visible = ((depth > 0) & (x > -12) & (x < width+12) &
               (y > -12) & (y < height+12) &
               ((x-center[0])**2+(y-center[1])**2 > max(0, radius-3)**2))
    for index in np.flatnonzero(visible):
        px, py = x[index], y[index]
        magnitude = stars['magnitude'][index]
        # Flux is proportional to 10**(-0.4*V). Square-root compression
        # keeps fainter real stars visible without overwhelming the globe.
        flux = 10**(-.4*magnitude)
        amplitude = (440/255)*(flux**.5)/(flux**.5+.11)
        sigma = display_scale*(1.05 + .7*np.clip((5-magnitude)/5, 0, 1.6))
        halo_sigma = display_scale*(4.0 + .7*max(0, 2-magnitude))
        reach = math.ceil(3*halo_sigma) if magnitude < 2 else math.ceil(3*sigma)
        left, right = max(0, int(px)-reach), min(width, int(px)+reach+2)
        top, bottom = max(0, int(py)-reach), min(height, int(py)+reach+2)
        if left >= right or top >= bottom:
            continue
        sy, sx = np.ogrid[top:bottom, left:right]
        distance2 = (sx-px)**2+(sy-py)**2
        light = amplitude*np.exp(-distance2/(2*sigma*sigma))
        if magnitude < 2:
            light += (2-magnitude)*(7/255)*np.exp(-distance2/(2*halo_sigma*halo_sigma))
        sky[top:bottom,left:right] += visibility*TRIP.style['star_strength']*light[...,None]*stars['color'][index]
    return sky


def star_background(bs, dt, radius, size=(1080, 1920), center=(540, 960), *, visibility=1.0):
    """Display preview only; the scene compositor uses star_radiance."""
    return display_image(star_radiance(bs, dt, radius, size, center, visibility=visibility))
