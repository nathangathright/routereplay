"""Clear-sky lux anchors and the retained instantaneous diagnostic model.

Production lamp switching is chronological in causal_lights.py; regional
populations/schedules live in citypopulations.py. The functions below preserve
the previous stateless diagnostic API, not calibrated photometry or causal
cloud-sensitive control. Source radiance no longer uses display_visibility.
"""
import numpy as np

# Hulburt's measured horizontal clear-sky values at 0, -3, -6 and -9 degrees.
# The remaining anchors extend that curve for rendering, not observations.
SOLAR_ALTITUDE = np.array([-90., -18., -12., -9., -6., -3., 0., 6., 15., 45., 90.])
SKY_LUX = np.array([.0001, .0001, .001, .054, 1.35, 43., 430.,
                    8000., 25000., 80000., 120000.])


def clear_sky_illuminance(solar_cosine):
    altitude = np.degrees(np.arcsin(np.clip(solar_cosine, -1, 1)))
    return 10 ** np.interp(altitude, SOLAR_ALTITUDE, np.log10(SKY_LUX))


def _population(log_threshold, log_illuminance, spread):
    return 1 / (1 + np.exp(np.clip((log_illuminance - log_threshold) / spread,
                                  -60, 60)))


def activation_components(solar_cosine, regional, district, solar_rate=-6.):
    """Return unresolved source populations and their weighted activation.

    solar_rate is geometric solar-altitude change in degrees per hour, positive
    at dawn. The smooth rate response approximates different on/off thresholds
    without frame history or a discontinuity at stationary Sun. It is not a
    causal photocell simulation under changing cloud illumination. Clouds are
    deliberately excluded from this clear-sky sensor model.
    """
    solar_cosine, regional, district, solar_rate = np.broadcast_arrays(
        solar_cosine, regional, district, solar_rate)
    illuminance = clear_sky_illuminance(solar_cosine)
    log_lux = np.log10(illuminance)
    variation = .6 * (regional - .5) + .4 * (district - .5)
    on_lux = 16.1 * 10 ** (.8 * variation)
    dawn = .5 + .5 * np.tanh(solar_rate / 1.5)
    threshold = on_lux * 3 ** dawn
    outdoor = _population(np.log10(threshold), log_lux, .16)
    building_threshold = 100 * 10 ** (.45 * (district - .5))
    building = _population(np.log10(building_threshold), log_lux, .32)
    # These are illustrative emission shares, not inferred land use. Brightness
    # in the satellite texture never determines which kind of source is present.
    outdoor_share = .60 + .14 * (regional - .5)
    persistent_share = .10 + .04 * (district - .5)
    building_share = 1 - outdoor_share - persistent_share
    activation = (outdoor_share * outdoor + building_share * building
                  + persistent_share)
    return {'illuminance_lux': illuminance, 'on_threshold_lux': on_lux,
            'effective_threshold_lux': threshold, 'outdoor': outdoor,
            'building': building, 'persistent_share': persistent_share,
            'activation': activation}


def display_visibility(illuminance_lux, level):
    """Artistic contrast budget, separate from source activation.

    Existing brighter sources can be read against a brighter sky. This gain is
    not camera exposure or a lux-to-RGB conversion. It tends to one at night.
    """
    budget = 30 + 100 * np.sqrt(np.clip(level, 0, 1))
    return 1 / (1 + (illuminance_lux / budget) ** .7)


def city_light_gain(level, solar_cosine, regional, district, solar_rate=-6.):
    components = activation_components(solar_cosine, regional, district, solar_rate)
    return components['activation'] * display_visibility(components['illuminance_lux'], level)
