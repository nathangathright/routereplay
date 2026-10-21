"""Linear Cycles radiance and shared ray depth, or explicit level diagram fallback.

Diagram previews rotate heading only; bank/pitch require the 3D Cycles path.
"""
from dataclasses import dataclass
from functools import lru_cache
import numpy as np
from PIL import Image, ImageDraw
from runtime import AIRCRAFT_DIR, AIRCRAFT_MODE
from camera_geometry import EARTH_M, focal_length, distance as camera_distance
from radiometry import resize_float, srgb_to_linear, tone_map


@dataclass(frozen=True)
class AircraftLayer:
    radiance: np.ndarray
    alpha: np.ndarray
    depth: np.ndarray
    model_camera_height_m: float = 0.
    ground_clearance_m: float = 0.
    depth_error_earth: float = 0.
    bank_deg: float = 0.
    pitch_deg: float = 0.

    def __post_init__(self):
        values = [np.array(value, dtype=np.float32, copy=True)
                  for value in (self.radiance, self.alpha, self.depth)]
        light, alpha, depth = values
        if (not np.isfinite(self.model_camera_height_m) or self.model_camera_height_m < 0 or
                not np.isfinite(self.ground_clearance_m) or self.ground_clearance_m < 0 or
                not np.isfinite(self.depth_error_earth) or self.depth_error_earth < 0):
            raise ValueError('Invalid aircraft physical scale or ground clearance.')
        if any(not np.isfinite(value) or abs(value)>=90 for value in (self.bank_deg,self.pitch_deg)):
            raise ValueError('Invalid aircraft bank/pitch cache angles.')
        if (light.ndim != 3 or light.shape[-1] != 3 or
                alpha.shape != light.shape[:2] + (1,) or depth.shape != light.shape[:2]):
            raise ValueError('Aircraft cache requires RGB radiance, one-channel alpha and ray depth.')
        if (not np.isfinite(light).all() or np.any(light < 0) or
                not np.isfinite(alpha).all() or np.any((alpha < 0) | (alpha > 1)) or
                np.isnan(depth).any() or np.any(depth <= 0) or
                np.any((alpha[..., 0] > 0) & ~np.isfinite(depth))):
            raise ValueError('Invalid aircraft radiance, coverage or depth cache.')
        for name, value in zip(('radiance', 'alpha', 'depth'), values):
            value.setflags(write=False)
            object.__setattr__(self, name, value)
        covered_depth = depth[alpha[...,0] > 0]
        # Every float32 storage/cast contributes at most half an ULP. Retain
        # the accumulated bound through resize and type blending so terrain
        # tolerances follow actual precision instead of an arbitrary metre.
        rounding = (float(np.max(np.ldexp(1.,np.maximum(np.frexp(covered_depth)[1]-24,-149))))/2
                    if covered_depth.size else 0.)
        object.__setattr__(self,'depth_error_earth',self.depth_error_earth+rounding)


@lru_cache(maxsize=1)
def diagram():
    image = Image.new('RGBA', (384, 384))
    draw = ImageDraw.Draw(image)
    outline = [(192,35),(205,76),(205,158),(327,235),(327,251),
               (204,217),(204,294),(239,322),(239,335),(192,321),
               (145,335),(145,322),(180,294),(180,217),(57,251),
               (57,235),(179,158),(179,76)]
    draw.polygon(outline, fill=(235,238,242,255), outline=(85,106,129,255), width=3)
    return image


def anchor_depth(radius, altitude_m, size=(224, 224)):
    """Depth of the local horizontal aircraft anchor along shared camera rays."""
    w,h=size
    yy,xx=np.mgrid[:h,:w]
    factor=np.sqrt(1+((xx+.5-w/2)/focal_length())**2+((yy+.5-h/2)/focal_length())**2)
    return ((camera_distance(radius)-1-altitude_m/EARTH_M)*factor).astype(np.float32)


@lru_cache(maxsize=8)
def _cached_layer(path):
    try:
        with np.load(path, allow_pickle=False) as data:
            if int(data['schema_version']) != 2:
                raise ValueError('Unsupported aircraft cache version.')
            height = float(data['model_camera_height_m'])
            if height <= 0:
                raise ValueError('Aircraft physical scale must be positive.')
            return AircraftLayer(data['radiance'], data['alpha'], data['depth'],
                                 height, float(data['ground_clearance_m']),
                                 bank_deg=float(data['bank_deg']),pitch_deg=float(data['pitch_deg']))
    except (OSError, KeyError, ValueError) as error:
        raise ValueError(f'Linear aircraft cache missing or invalid: {path}; rebuild with Cycles.') from error


@lru_cache(maxsize=8)
def _bilinear_weights(source, target):
    """Pillow's bilinear filter footprint, retaining float64 depth precision."""
    scale = source / target
    centers = (np.arange(target) + .5) * scale
    weights = np.maximum(1 - np.abs(centers[:, None] -
                         (np.arange(source) + .5)[None, :]) / max(scale, 1), 0)
    weights /= weights.sum(axis=1, keepdims=True)
    weights.setflags(write=False)
    return weights


@lru_cache(maxsize=8)
def _crop_ray_cosine(size):
    """Exact ray cosines for a raster sampling the same 224px display crop."""
    w, h = size
    yy, xx = np.mgrid[:h, :w]
    f = focal_length() * w / 224
    result = 1 / np.sqrt(1 + ((xx+.5-w/2)/f)**2 + ((yy+.5-h/2)/f)**2)
    result.setflags(write=False)
    return result


def _resize_layer(layer, size, *, shared_rays=False):
    alpha = np.clip(resize_float(layer.alpha, size), 0, 1)
    light = np.maximum(resize_float(layer.radiance, size), 0)
    # Coverage-weighted depth avoids infinity at the edge. Compute both weight
    # sums in float64: float32 products can underflow at subnormal alpha, and
    # dividing by independently rounded display coverage biases the depth.
    horizontal = _bilinear_weights(layer.depth.shape[1], size[0])
    vertical = _bilinear_weights(layer.depth.shape[0], size[1])
    coverage = layer.alpha[..., 0].astype(np.float64)
    shared_rays = shared_rays or layer.model_camera_height_m > 0
    surface_depth = np.where(np.isfinite(layer.depth), layer.depth, 0).astype(np.float64)
    if shared_rays:
        # Filter axial depth (hence surface height), then reconstruct the new
        # ray distance. Filtering ray distances directly shifts alpha edges
        # several physical metres below a flat surface when the icon shrinks.
        surface_depth *= _crop_ray_cosine((layer.depth.shape[1], layer.depth.shape[0]))
    weighted = surface_depth * coverage
    numerator = vertical @ weighted @ horizontal.T
    denominator = vertical @ coverage @ horizontal.T
    covered = alpha[..., 0] > 0
    distance = np.divide(numerator, denominator, out=np.full_like(numerator, np.inf),
                         where=covered)
    if covered.any():
        finite_depth = surface_depth[layer.alpha[..., 0] > 0]
        # A positive weighted mean must stay in the source depth range; enforce
        # that bound before the final float32 cast at its largest finite value.
        distance[covered] = np.clip(distance[covered], finite_depth.min(), finite_depth.max())
    if shared_rays:
        distance /= _crop_ray_cosine(tuple(size))
    return AircraftLayer(light, alpha, distance, layer.model_camera_height_m,
                         layer.ground_clearance_m, layer.depth_error_earth,
                         layer.bank_deg,layer.pitch_deg)


def terrain_visibility(layer, radius, altitude_m, vertical_scale, basis, sample_terrain):
    """Test terrain at the actual airframe footprint, in physical metres.

    The display model is enlarged independently of the globe: using the map
    depth under its screen pixels would let mountains tens of kilometres away
    slice through a parked aircraft. Reconstruct the original model-space ray
    hits, then sample terrain only under that metre-scale footprint. Cloud and
    atmosphere transport continue to use the shared display rays and depth.
    """
    h, w = layer.depth.shape
    covered = layer.alpha[..., 0] > 0
    depth = np.where(covered, layer.depth, 0).astype(np.float64)
    height = (camera_distance(radius) - depth * _crop_ray_cosine((w,h)) - 1) * EARTH_M / vertical_scale
    model_height = height - altitude_m - layer.ground_clearance_m
    model_distance = np.maximum(0, layer.model_camera_height_m - model_height)
    yy,xx = np.mgrid[:h,:w]
    focal = focal_length() * w / 224
    xy = np.stack([(xx+.5-w/2)/focal,(h/2-yy-.5)/focal],axis=-1) * model_distance[...,None]
    # Diagram previews have no physical mesh; their reference is the anchor.
    if layer.model_camera_height_m == 0:
        xy = np.zeros_like(xy)
    bs = np.asarray(basis, np.float64)
    world = bs[2] + (xy[..., 0, None] * bs[0] + xy[..., 1, None] * bs[1]) / EARTH_M
    world /= np.linalg.norm(world, axis=-1, keepdims=True)
    terrain = np.asarray(sample_terrain(world))
    tolerance_m = layer.depth_error_earth * EARTH_M / vertical_scale
    return covered & (height + tolerance_m >= terrain)


def plane_radiance(motion, t, tick, *, size=(224, 224), altitude_m=None):
    """Return premultiplied light/coverage/depth; diagram mode omits 3D attitude."""
    if AIRCRAFT_MODE == 'diagram':
        image = diagram().rotate(-motion.heading(t), resample=Image.Resampling.BICUBIC)
        rgba = np.asarray(image, np.float32) / 255
        alpha = rgba[..., 3:]
        from astronomy import sun_direction
        solar = max(0., float(motion.camera(t)[2] @ sun_direction(motion.trip.travel_time(t))))
        light = srgb_to_linear(rgba[..., :3]) * alpha * (.03 + solar)
        altitude = motion.altitude(t) if altitude_m is None else altitude_m
        # Source pixels cover a 224px crop even though its cached raster is 384.
        axial = camera_distance(motion.zoom(t)) - 1 - altitude/EARTH_M
        depth = axial / _crop_ray_cosine((384,384))
        depth = np.where(alpha[..., 0] > 0, depth, np.inf)
        return _resize_layer(AircraftLayer(light, alpha, depth), size, shared_rays=True)
    layers = []
    for leg, weight in motion.aircraft_mix(t):
        kind = motion.trip.legs[leg].aircraft
        path = AIRCRAFT_DIR / ('frames-'+kind) / f'frame-{tick:04d}.npz'
        layers.append((_resize_layer(_cached_layer(str(path)), size), weight))
    if len(layers) == 1:
        return layers[0][0]
    light = sum(layer.radiance * weight for layer, weight in layers)
    coverage = sum(layer.alpha[..., 0].astype(np.float64) * weight for layer, weight in layers)
    alpha = coverage[..., None].astype(np.float32)
    depth_weight = sum(np.where(np.isfinite(layer.depth), layer.depth, 0) *
                       layer.alpha[..., 0].astype(np.float64) * weight for layer, weight in layers)
    covered = alpha[..., 0] > 0
    depth = np.divide(depth_weight, coverage, out=np.full_like(depth_weight, np.inf),
                      where=covered)
    if covered.any():
        finite_depth = np.concatenate([layer.depth[layer.alpha[..., 0] > 0] for layer, _ in layers])
        depth[covered] = np.clip(depth[covered], finite_depth.min(), finite_depth.max())
    return AircraftLayer(light, alpha, depth,
                         sum(layer.model_camera_height_m * weight for layer, weight in layers),
                         sum(layer.ground_clearance_m * weight for layer, weight in layers),
                         sum(layer.depth_error_earth * weight for layer, weight in layers),
                         sum(layer.bank_deg * weight for layer, weight in layers),
                         sum(layer.pitch_deg * weight for layer, weight in layers))


def plane_sprite(motion, t, tick):
    """Display preview adapter; the scene compositor consumes plane_radiance."""
    layer = plane_radiance(motion, t, tick, size=(384, 384))
    color = np.divide(layer.radiance, layer.alpha, out=np.zeros_like(layer.radiance),
                      where=layer.alpha > 0)
    return Image.fromarray(np.rint(np.concatenate((tone_map(color), layer.alpha), -1) * 255).astype(np.uint8))
