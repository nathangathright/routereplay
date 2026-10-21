"""Scene-relative linear RGB transport and the single display transform.

Diffuse white in direct Sun is approximately one. These values are useful
shared rendering units, not calibrated photometry. Radiance has no upper bound.
"""
from dataclasses import dataclass

import numpy as np
from PIL import Image

LUMA = np.array([.2126, .7152, .0722], dtype=np.float32)


def srgb_to_linear(value):
    """Decode normalized display RGB; alpha must be handled separately."""
    value = np.asarray(value, dtype=np.float32)
    return np.where(value <= .04045, value / 12.92,
                    ((np.maximum(value, 0) + .055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(value):
    """Encode linear RGB without clipping HDR values."""
    value = np.maximum(np.asarray(value, dtype=np.float32), 0)
    return np.where(value <= .0031308, value * 12.92,
                    1.055 * value ** (1 / 2.4) - .055).astype(np.float32)


def resize_float(value, size, resample=Image.Resampling.BILINEAR):
    """Resize float channels independently, retaining values above one."""
    value = np.asarray(value, dtype=np.float32)
    if value.ndim == 2:
        return np.asarray(Image.fromarray(value).resize(tuple(size), resample),
                          dtype=np.float32).copy()
    if value.ndim != 3:
        raise ValueError('Expected an H×W or H×W×C float image.')
    return np.stack([resize_float(value[..., i], size, resample)
                     for i in range(value.shape[-1])], axis=-1)


def source_over(radiance, alpha, background):
    """Composite premultiplied linear source radiance over an RGB background."""
    alpha = np.asarray(alpha, dtype=np.float32)
    if alpha.ndim == np.asarray(radiance).ndim - 1:
        alpha = alpha[..., None]
    return np.asarray(radiance, dtype=np.float32) + (1 - alpha) * background


@dataclass(frozen=True)
class TransportLayer:
    """Immutable additive in-scattering and remaining background transmission."""
    radiance: np.ndarray
    transmittance: np.ndarray

    def __post_init__(self):
        radiance = np.array(self.radiance, dtype=np.float32, copy=True)
        transmittance = np.array(self.transmittance, dtype=np.float32, copy=True)
        if radiance.ndim != 3 or radiance.shape[-1] != 3:
            raise ValueError('Radiance must be H×W×3.')
        if transmittance.ndim == 2:
            transmittance = transmittance[..., None]
        if (transmittance.ndim != 3 or transmittance.shape[:2] != radiance.shape[:2] or
                transmittance.shape[-1] not in (1, 3)):
            raise ValueError('Transmittance must be H×W×1 or H×W×3.')
        if (not np.all(np.isfinite(radiance)) or np.any(radiance < 0) or
                not np.all(np.isfinite(transmittance)) or
                np.any((transmittance < 0) | (transmittance > 1))):
            raise ValueError('Transport requires finite nonnegative light and transmission in [0, 1].')
        radiance.setflags(write=False)
        transmittance.setflags(write=False)
        object.__setattr__(self, 'radiance', radiance)
        object.__setattr__(self, 'transmittance', transmittance)

    def over(self, background):
        return self.radiance + self.transmittance * np.asarray(background, dtype=np.float32)


def tone_map(radiance, exposure=1.):
    """One exposure and smooth shoulder, followed by the sRGB display encoding.

    Per-channel Reinhard is monotone for all nonnegative finite inputs. Values
    above one remain distinct until this final display conversion.
    """
    if not np.isfinite(exposure) or exposure <= 0:
        raise ValueError('Exposure must be finite and positive.')
    value = np.asarray(radiance, dtype=np.float32)
    if not np.all(np.isfinite(value)):
        raise ValueError('Radiance must be finite before display conversion.')
    value = np.maximum(value, 0) * np.float32(exposure)
    return linear_to_srgb(value / (1 + value))


def display_image(radiance, exposure=1.):
    return Image.fromarray(np.rint(tone_map(radiance, exposure) * 255).astype(np.uint8)).convert('RGBA')


def causal_exposure_profile(times, brightness, *, adaptation_seconds=.75,
                            minimum=.8, maximum=2.2, middle_gray=.18):
    """Chronological immutable exposure prepass, independent of sample order.

    Meter values are scene-linear means from a fixed geographic proxy. Adapt
    log exposure causally; no future sample can alter an earlier exposure.
    """
    times = np.asarray(times, dtype=float)
    brightness = np.asarray(brightness, dtype=float)
    if (times.ndim != 1 or times.shape != brightness.shape or
            not np.all(np.isfinite(times)) or not np.all(np.isfinite(brightness)) or
            np.any(np.diff(times) < 0) or np.any(brightness < 0) or
            adaptation_seconds <= 0 or not 0 < minimum <= maximum or middle_gray <= 0):
        raise ValueError('Use finite ordered times, nonnegative meters and positive exposure controls.')
    target = np.log(np.clip(middle_gray / np.maximum(brightness, 1e-8), minimum, maximum))
    result = target.copy()
    for index in range(1, len(times)):
        weight = -np.expm1(-(times[index] - times[index - 1]) / adaptation_seconds)
        result[index] = result[index - 1] + weight * (target[index] - result[index - 1])
    result = np.exp(result).astype(np.float32)
    result.setflags(write=False)
    return result
