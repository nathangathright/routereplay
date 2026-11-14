/**
 * The homepage's tools: look up an airport's time zone and offset, and make a draft from a spec, which the page then
 * becomes, with the draft's own tools (scene.ts) in place of these. An agent that can't make HTTP requests can still
 * make a journey this way. The credentials stay with the page: the person can copy the private link from the chat.
 */
import type { SceneSpecV1 } from '../../shared/scene/types';
import { createScene, lookupAirport } from '../api';
import type { ChatBridge } from '../draft';
import type { ToolDef } from './core';
import { apiFailed, chatChanging, failed, journeyFacts } from './results';

export interface HomeToolContext {
  origin: string;
  chat: () => ChatBridge | null;
  /** Make this page the new draft's, with the owner credential, as the chat does for a trip it read. */
  open: (sceneId: string, ownerCredential: string) => void;
}

export function homeTools(ctx: HomeToolContext): ToolDef[] {
  return [
    {
      name: 'lookup_airport',
      title: 'Look up an airport',
      description:
        'Look up an airport by its 3-letter IATA code: name, coordinates and IANA time zone. With `local` (YYYY-MM-DDTHH:MM), also the UTC offset valid at that local time, both offsets when clocks fall back, or none when they spring forward. Use it to write each time with the right offset, including daylight saving time.',
      inputSchema: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', pattern: '^[A-Za-z]{3}$', description: 'IATA airport code, such as ORD.' },
          local: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', description: 'A local date and time there.' },
        },
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const code = String(input.code ?? '');
        if (!/^[A-Za-z]{3}$/.test(code)) return failed('pattern', 'code must be a 3-letter IATA airport code, such as ORD.');
        try {
          return { ok: true, ...(await lookupAirport(code.toUpperCase(), input.local as string | undefined)).body! };
        } catch (e) {
          return apiFailed(e);
        }
      },
    },
    {
      name: 'create_scene',
      title: 'Make a journey',
      description: `Validate a scene spec and save it as a private draft, which this page then shows, with the page’s chat beside it for the person. Read ${ctx.origin}/agent-docs first: it says how to gather the itinerary and build the spec (schema: ${ctx.origin}/schemas/scene-v1.json). On validation_failed nothing is saved; issues give JSON Pointer paths and hints. Afterwards this page offers the draft’s tools (get_scene, set_scene, get_storyboard, control_playback, publish_scene, export_video) in place of these.`,
      inputSchema: {
        type: 'object',
        required: ['spec'],
        additionalProperties: false,
        properties: { spec: { type: 'object', description: 'The complete scene spec (schemaVersion 1).' } },
      },
      annotations: { readOnlyHint: false },
      async execute(input) {
        if (ctx.chat()?.state().changing) return chatChanging('person');
        try {
          const created = (await createScene(input.spec as SceneSpecV1)).body!;
          ctx.open(created.id, created.credentials.owner);
          return {
            ok: true,
            sceneId: created.id,
            revision: created.revision,
            warnings: created.warnings,
            journey: journeyFacts(created.normalized),
            next: [
              ...(created.warnings.length ? ['Raise material warnings with the person in plain words.'] : []),
              'This page now shows the draft. Once the draft’s tools appear, compare get_storyboard with what the person asked for.',
              'The draft lives in this browser’s session. To keep it beyond that or open it elsewhere, the person can copy its private link from the trip’s menu in the chat (the title, then ⋮). It lets anyone edit, publish or delete the draft, so it is theirs to keep: don’t ask for it.',
            ],
          };
        } catch (e) {
          return apiFailed(e);
        }
      },
    },
  ];
}
