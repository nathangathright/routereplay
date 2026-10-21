"""Shared finite perspective camera for Earth, volumes and celestial objects.

Distances are Earth radii. Camera coordinates are east/right, north/up and
radially outward. All passes use a 70-degree horizontal FOV. The chosen Earth
silhouette radius controls the observer distance, preserving the cinematic
distance-scaled zoom while providing finite-object parallax and common depth.
"""
from functools import lru_cache
import math
import numpy as np

EARTH_M = 6_371_000.0
HORIZONTAL_FOV_DEGREES = 70.0


def focal_length(width=1080):
    return width / (2 * math.tan(math.radians(HORIZONTAL_FOV_DEGREES / 2)))


def distance(radius, width=1080):
    return math.sqrt(1 + (focal_length(width) / float(radius)) ** 2)


@lru_cache(maxsize=12)
def _directions(size, center, scale, sensor_width):
    width, height = size
    small = (math.ceil(width / scale), math.ceil(height / scale))
    yy, xx = np.mgrid[:small[1], :small[0]].astype(np.float32)
    f = focal_length(sensor_width)
    dx = ((xx + .5) * width / small[0] - center[0]) / f
    dy = (center[1] - (yy + .5) * height / small[1]) / f
    rays = np.stack([dx, dy, -np.ones_like(dx)], axis=-1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    return rays


def pixel_rays(radius, size=(1080, 1920), center=(540, 960), scale=1,
               sensor_width=1080):
    """Return local-camera origin(3) and normalized rays(H,W,3).

    For a centered aircraft crop use size=(224,224), center=(112,112), retaining
    sensor_width=1080 so its pixel angles match the full canvas.
    """
    origin = np.array([0, 0, distance(radius, sensor_width)], np.float32)
    return origin, _directions(tuple(size), tuple(center), scale, sensor_width)


def pixel_rays_at(radius, coordinates, center=(540, 960), sensor_width=1080):
    """Return the same camera rays at explicit output pixel coordinates (x,y).

    Pixel centres are half integers. Coordinates may also be the fractional
    centres of a reduced grid; no rounding or temporal jitter is applied.
    """
    coordinates = np.asarray(coordinates, np.float32)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2:
        raise ValueError('coordinates must be an N×2 array of output pixel positions')
    if not np.all(np.isfinite(coordinates)):
        raise ValueError('coordinates must be finite')
    f = focal_length(sensor_width)
    dx = (coordinates[:, 0] - center[0]) / f
    dy = (center[1] - coordinates[:, 1]) / f
    rays = np.stack([dx, dy, -np.ones_like(dx)], axis=-1)
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    origin = np.array([0, 0, distance(radius, sensor_width)], np.float32)
    return origin, rays


def sphere_interval(origin, directions, radius=1):
    """Near/far forward ray distances and hit mask, with tangent-safe roots."""
    origin, directions = np.asarray(origin), np.asarray(directions)
    b = np.sum(origin * directions, axis=-1)
    c = np.sum(origin * origin, axis=-1) - np.asarray(radius) ** 2
    discriminant = b * b - c
    root = np.sqrt(np.maximum(discriminant, 0))
    near, far = -b - root, -b + root
    hit = (discriminant >= 0) & (far >= 0)
    return np.maximum(near, 0), far, hit


def project(points, bs, radius, raised=1, size=(1080, 1920), center=(540, 960)):
    """Return screen x/y and a signed Earth visibility margin.

    Surface markers include a normalized limb margin; elevated paths use
    actual ray/sphere occlusion. Negative margins are behind the Earth.
    """
    points = np.asarray(points) * np.asarray(raised)[..., None]
    local = points @ np.asarray(bs).T
    d = distance(radius, size[0])
    delta = local - np.array([0, 0, d])
    length = np.linalg.norm(delta, axis=-1)
    rays = delta / np.maximum(length[..., None], 1e-9)
    near, _, hit = sphere_interval(np.array([0, 0, d]), rays)
    norms = np.linalg.norm(local, axis=-1)
    surface = np.abs(norms - 1) < 1e-5
    margin = (d * local[..., 2] - 1) / (d - 1)
    margin = np.where(surface, margin, np.where(hit & (length > near + 2e-5), -1., 1.))
    denominator = np.maximum(d - local[..., 2], 1e-6)
    f = focal_length(size[0])
    return np.stack([center[0] + f * local[..., 0] / denominator,
                     center[1] - f * local[..., 1] / denominator, margin], axis=-1)
