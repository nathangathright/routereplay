import { AIRCRAFT_DESIGNATORS } from './aircraft';
import {
  AIRPORT_CODE_PATTERN,
  DEFAULTS,
  HOLD_MINUTES,
  LEG_ID_PATTERN,
  LIMITS,
  STYLE_PRESETS,
  TIMESTAMP_PATTERN,
  WEATHER_TREATMENTS,
} from './constants';

/**
 * Authoring JSON Schema for scene spec version 1, published at /schemas/scene-v1.json.
 *
 * The schema covers structure. Cross-field rules (connected legs, ordered times,
 * airport offsets, the duration budget) are enforced by the service and documented
 * in the descriptions and in /agent-docs.
 */
export const sceneSchemaV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: '/schemas/scene-v1.json',
  title: 'Route Replay scene spec, version 1',
  description:
    'A data-only description of a journey to animate on a 3D Earth. Submit it to POST /api/v1/scenes or PUT /api/v1/scenes/{id}. ' +
    'The service resolves airports, converts times to UTC, fills defaults, and returns a normalized record. ' +
    'Do not include passenger names, booking references, source URLs, or research notes.',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'legs'],
  properties: {
    schemaVersion: { const: 1, description: 'Contract version. Must be 1.' },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: LIMITS.maxTitleLength,
      description:
        'Optional page title shown beside the player, never drawn inside the scene. Keep it generic (for example "Chicago to Auckland").',
    },
    legs: {
      type: 'array',
      minItems: 1,
      maxItems: LIMITS.maxLegs,
      description:
        'Ordered, connected flights. Each leg must depart from the previous leg\'s arrival airport, and may not depart before the previous arrival. Repeated airports are allowed.',
      items: { $ref: '#/$defs/leg' },
    },
    presentation: {
      type: 'object',
      additionalProperties: false,
      description: 'How the journey is shown. Every field is optional.',
      properties: {
        durationSeconds: {
          type: 'number',
          minimum: LIMITS.minDurationSeconds,
          maximum: LIMITS.maxDurationSeconds,
          description: `Total presentation length in seconds. Default: start hold + end hold + stop holds + ${DEFAULTS.secondsPerLeg} s per leg (at least ${DEFAULTS.minFlightSeconds} s of flight), capped at ${LIMITS.maxDurationSeconds}. Every flight must receive at least ${LIMITS.minLegSeconds} s after holds are subtracted.`,
        },
        legWeights: {
          type: 'object',
          description: `Relative share of flight time keyed by leg id. Unlisted legs use a distance-based default (average 1). Increase a weight to slow that leg. Range ${LIMITS.minLegWeight}–${LIMITS.maxLegWeight}.`,
          propertyNames: { pattern: LEG_ID_PATTERN },
          additionalProperties: { type: 'number', minimum: LIMITS.minLegWeight, maximum: LIMITS.maxLegWeight },
        },
        stopHolds: {
          type: 'object',
          description: `Seconds spent at a connection, keyed by the id of the leg that arrives there. The real connection time is animated (sunlight changes) while the aircraft waits. 0 cuts straight to the next departure. Not allowed for the final leg; use endHoldSeconds. Default ${DEFAULTS.stopHoldSeconds}.`,
          propertyNames: { pattern: LEG_ID_PATTERN },
          additionalProperties: { type: 'number', minimum: 0, maximum: LIMITS.maxStopHoldSeconds },
        },
        startHoldSeconds: {
          type: 'number',
          minimum: 0,
          maximum: LIMITS.maxStartEndHoldSeconds,
          description: `Seconds at the origin before the first departure. They show the ${HOLD_MINUTES} minutes before departure, so the Sun and clouds keep moving. Default ${DEFAULTS.startHoldSeconds}.`,
        },
        endHoldSeconds: {
          type: 'number',
          minimum: 0,
          maximum: LIMITS.maxStartEndHoldSeconds,
          description: `Seconds at the final destination after arrival. They show the ${HOLD_MINUTES} minutes after arrival. Default ${DEFAULTS.endHoldSeconds}.`,
        },
      },
    },
    environment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        weather: {
          enum: [...WEATHER_TREATMENTS],
          description:
            'Weather treatment. "clouds" (default): cloud cover from NOAA\'s GFS weather model at the journey\'s times (analysis for past times, forecast for upcoming ones; 22 March 2021 to 16 days after the save). "omitted": no clouds.',
        },
      },
    },
    assets: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: { enum: [...STYLE_PRESETS], description: 'Approved visual style preset.' },
      },
    },
    seed: {
      type: 'integer',
      minimum: 0,
      maximum: LIMITS.maxSeed,
      description: `Seed for decorative randomness such as the star field. Default ${DEFAULTS.seed}.`,
    },
  },
  $defs: {
    leg: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'from', 'to', 'departure', 'arrival', 'aircraft'],
      properties: {
        id: {
          type: 'string',
          pattern: LEG_ID_PATTERN,
          maxLength: LIMITS.maxLegIdLength,
          description: 'Stable lowercase id, unique within the scene, such as "ord-sfo" or "leg-2". Keep ids unchanged when revising so pacing settings still apply.',
        },
        from: { type: 'string', pattern: AIRPORT_CODE_PATTERN, description: 'IATA airport code of departure, e.g. "ORD".' },
        to: { type: 'string', pattern: AIRPORT_CODE_PATTERN, description: 'IATA airport code of arrival, e.g. "SFO".' },
        departure: {
          type: 'string',
          pattern: TIMESTAMP_PATTERN,
          description:
            'Departure time as ISO 8601 with the departure airport\'s local UTC offset at that moment, e.g. "2031-01-05T10:00:00-06:00". The offset must match the airport\'s time zone, including daylight saving time; "Z" is accepted only where the local offset is zero.',
        },
        arrival: {
          type: 'string',
          pattern: TIMESTAMP_PATTERN,
          description: 'Arrival time in the arrival airport\'s local offset, using the same rules as departure. Must be after departure.',
        },
        aircraft: {
          enum: [...AIRCRAFT_DESIGNATORS],
          description:
            'ICAO type designator of the aircraft that flew (or is scheduled to fly) this leg, e.g. "B38M" for a Boeing 737 MAX 8 or "A21N" for an Airbus A321neo. The scene draws that type. Find it in the flight\'s history or the airline\'s schedule. If the type is not listed, choose the closest listed type and tell the creator.',
        },
      },
    },
  },
} as const;
