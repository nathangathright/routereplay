/**
 * The chat's questions and answers (ChatFaq.tsx): what happens to the text typed into the chat, who can see a draft,
 * where the routes and clouds come from. They're answered here in the page, so asking costs no message and no model
 * call. Each answer is paragraphs; `[text](/path)` in one is a link to a page on the site.
 */
import { DRAFT_RETENTION_DAYS, SESSION_DAYS } from '../shared/retention';

export interface FaqItem {
  id: string;
  question: string;
  answer: string[];
}

export interface FaqSection {
  title: string;
  items: FaqItem[];
}

/** The question the chat's privacy line opens. */
export const PRIVACY_QUESTION = 'chat-text';

/** `host`: the site's host name, as an agent would be pointed at it ("routereplay.video"). */
export function faq(host: string): FaqSection[] {
  return [
    {
      title: 'The chat',
      items: [
        {
          id: PRIVACY_QUESTION,
          question: 'What happens to the itinerary I type into the chat?',
          answer: [
            'To read it, Route Replay sends the text to Cloudflare Workers AI, on the same network that hosts this site. Neither Cloudflare nor Route Replay keeps the text or uses it to train models: the model reads it, Route Replay turns what it found into a journey, and the text is discarded. Each new message sends the conversation so far, to be read the same way.',
            'Your browser keeps each draft’s conversation, so it’s there when you open the draft again in the same browser. It isn’t sent anywhere else.',
          ],
        },
        {
          id: 'draft-contents',
          question: 'What does a draft keep?',
          answer: [
            'For each leg: its airports, its local departure and arrival times, and its aircraft or how it was travelled. Also a title made from the place names. Not your messages.',
          ],
        },
        {
          id: 'local-times',
          question: 'Why does the chat ask for local times?',
          answer: [
            'The Sun, Moon, stars and clouds are drawn for the moment of each leg, so local times put day and night in the right place. The chat can’t look up schedules, so when you give only a flight number it asks for the times, and your own AI can look them up (see below).',
          ],
        },
        {
          id: 'typical-aircraft',
          question: 'Why is an aircraft “typical”?',
          answer: [
            'When you don’t name the aircraft, the chat picks a typical one for the distance: a narrow-body jet for shorter flights and a wide-body for long ones. Name the type and it changes.',
          ],
        },
        {
          id: 'own-ai',
          question: 'What can my own AI do?',
          answer: [
            'When the chat needs something that can be looked up, such as a flight’s times or a ferry timetable, it offers a request to copy into ChatGPT, Claude, Gemini or another AI. Paste the AI’s answer back into the chat.',
            `An AI agent that can make web requests can also build the whole journey itself: copy the prompt from the chat’s first message into it, or point it at [${host}/agent-docs](/agent-docs).`,
          ],
        },
        {
          id: 'message-limits',
          question: 'How many messages can I send?',
          answer: [
            'A limited number each hour, which the chat shows, and there’s a daily limit for everyone. When they run out, your own AI agent can make the journey instead. Reading these answers doesn’t use any.',
          ],
        },
      ],
    },
    {
      title: 'Drafts and sharing',
      items: [
        {
          id: 'who-can-see',
          question: 'Who can see my draft?',
          answer: [
            `Only someone with one of its links. A draft the chat makes stays open in your browser for ${SESSION_DAYS} days. Its private link opens it anywhere, and anyone with that link can edit, publish or delete the draft, so keep it to yourself. Route Replay stores only a fingerprint of the link’s key, not the key itself, so it can’t send you the link again.`,
          ],
        },
        {
          id: 'retention',
          question: 'How long are drafts kept?',
          answer: [`A draft that nobody has changed for ${DRAFT_RETENTION_DAYS} days is deleted, unless it was published.`],
        },
        {
          id: 'publishing',
          question: 'What does publishing do?',
          answer: [
            'It makes a watch link that anyone with the link can play. Watch pages are kept out of search engines, but chat apps show a preview with the journey’s title and places when you paste the link. A published journey stays until its draft is deleted.',
          ],
        },
        {
          id: 'download',
          question: 'Can I download the video?',
          answer: ['Yes: Export makes a video file in your browser, and nothing is uploaded.'],
        },
      ],
    },
    {
      title: 'The globe',
      items: [
        {
          id: 'flight-paths',
          question: 'Are the flight paths real?',
          answer: ['They’re illustrations, not recorded tracks. Each flight follows the great circle, the shortest path between its airports.'],
        },
        {
          id: 'surface-routes',
          question: 'Where do trains, buses, drives and ferries go?',
          answer: [
            'Along railways, roads and ferry lines from OpenStreetMap, looked up through BRouter and OSRM when the journey is saved. Where no route is found, the leg follows the great circle.',
          ],
        },
        {
          id: 'clouds',
          question: 'Where do the clouds come from?',
          answer: [
            'From NOAA’s Global Forecast System weather model for the journey’s times: its analysis, or its forecast for times after the journey was saved. They are not satellite photos.',
          ],
        },
      ],
    },
  ];
}

/** What follows the questions: where the credits are. */
export const FAQ_CREDITS = 'Credits for the imagery, data and software are in the [acknowledgments](/acknowledgments).';

export type AnswerPart = string | { text: string; href: string };

/** A paragraph as text and links: `[text](/path)` becomes a link to that page. */
export function answerParts(paragraph: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let at = 0;
  for (const m of paragraph.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)) {
    if (m.index > at) parts.push(paragraph.slice(at, m.index));
    parts.push({ text: m[1]!, href: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < paragraph.length) parts.push(paragraph.slice(at));
  return parts;
}
