#!/usr/bin/env node
/**
 * Builds the "Route Replay" Apple Shortcut, signs it with this Mac's Apple Account, and opens it in Shortcuts to add.
 * The shortcut hands a trip's text to the homepage chat, `/#trip=<text>`, which opens with it in the message box; the
 * chat reads it, asks what's missing and makes the draft (src/app/tripLink.ts). See docs/decisions.md, "A Siri shortcut
 * that hands the trip to the chat".
 *
 * Text arrives from Siri (what's on screen), the Share Sheet, Services on selected text, or a Finder Quick Action; with
 * none, the shortcut just opens the homepage. Images are read with on-device text recognition. So that a whole confirmation email fits
 * the chat's 4,000 characters, runs of spaces and blank lines are tidied, and text still over 3,000 characters is cut
 * there, at a line break where it can be.
 *
 * Usage (macOS only):
 *   npm run shortcut                       → "Route Replay", for https://routereplay.video
 *   npm run shortcut -- --local            → "Route Replay Local", for `npm run dev:worker` through portless
 *   npm run shortcut -- --origin <url>     → another deployment
 *   add --no-open to build and sign without importing.
 *
 * The signed file is written to .cache/shortcut/ and isn't committed: it's a binary, and each server needs its own build.
 * Rebuild instead of editing the shortcut in Shortcuts; a rebuild replaces it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The chat reads 4,000 characters a conversation; this leaves room to answer its questions. */
const MAX_TRIP = 3000;
/** Cut at the last line break after this many characters, or at MAX_TRIP if there's none. */
const MIN_CUT = 2000;

/**
 * The shortcut as a WFWorkflow property list. Action and parameter names follow what Shortcuts on macOS 27 writes;
 * UUIDs derive from `origin` and position, so the same origin always builds the same workflow.
 */
export function buildWorkflow({ origin }) {
  const actions = [];
  let serial = 0;
  const uuid = () => {
    const h = createHash('sha256').update(`routereplay-shortcut\n${origin}\n${serial++}`).digest('hex').toUpperCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };

  // Values a parameter can refer to.
  const shortcutInput = { Type: 'ExtensionInput' };
  const variable = (name) => ({ Type: 'Variable', VariableName: name });
  const attachment = (ref) => ({ Value: ref, WFSerializationType: 'WFTextTokenAttachment' });
  /** Text with variables in it: strings and references, in order. Shortcuts marks each reference with U+FFFC. */
  const text = (...parts) => {
    let string = '';
    const attachmentsByRange = {};
    for (const part of parts) {
      if (typeof part === 'string') string += part;
      else {
        attachmentsByRange[`{${string.length}, 1}`] = part;
        string += '￼';
      }
    }
    const value = Object.keys(attachmentsByRange).length ? { string, attachmentsByRange } : { string };
    return { Value: value, WFSerializationType: 'WFTextTokenString' };
  };

  /** Append an action; with `output`, give it a UUID and return a reference to its result. */
  function action(id, params = {}, output) {
    const UUID = output ? uuid() : undefined;
    actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: UUID ? { ...params, UUID } : params });
    return UUID ? { Type: 'ActionOutput', OutputUUID: UUID, OutputName: output } : undefined;
  }

  const comment = (s) => action('comment', { WFCommentActionText: s });
  const setVariable = (name, ref) => action('setvariable', { WFInput: attachment(ref), WFVariableName: name });

  // Conditions for `ifThen`.
  const subject = (ref) => ({ WFInput: { Type: 'Variable', Variable: attachment(ref) } });
  const hasNoValue = (ref) => ({ WFCondition: 101, ...subject(ref) });
  const is = (ref, s) => ({ WFCondition: 4, ...subject(ref), WFConditionalActionString: s });
  const isGreaterThan = (ref, n) => ({ WFCondition: 2, ...subject(ref), WFNumberValue: n });

  function ifThen(condition, then, otherwise) {
    const GroupingIdentifier = uuid();
    action('conditional', { GroupingIdentifier, WFControlFlowMode: 0, ...condition });
    then();
    if (otherwise) {
      action('conditional', { GroupingIdentifier, WFControlFlowMode: 1 });
      otherwise();
    }
    action('conditional', { GroupingIdentifier, WFControlFlowMode: 2, UUID: uuid() });
  }

  const max = MAX_TRIP.toLocaleString('en-US');
  comment(
    `Route Replay: opens the trip in Route Replay's chat at ${origin}, which asks what's missing and makes the journey. ` +
      'Built by scripts/shortcut.mjs in the routereplay-web repository; rebuild it there rather than editing here.',
  );
  comment(
    'Privacy: this shortcut doesn’t send your trip to Route Replay. It opens Route Replay’s chat with the trip in the message ' +
      'box, and the chat sends it to Cloudflare Workers AI only when you press Send.',
  );

  comment('With nothing passed in, open Route Replay, where the chat asks for the trip.');
  ifThen(hasNoValue(shortcutInput), () => {
    action('openurl', { WFInput: attachment(action('url', { WFURLActionURL: text(`${origin}/`) }, 'URL')) });
    action('exit');
  });

  comment('The trip: what Siri, the Share Sheet or Services passed in.');
  ifThen(
    is(action('getitemtype', { WFInput: attachment(shortcutInput) }, 'Type'), 'Image'),
    () => setVariable('Trip', action('extracttextfromimage', { WFImage: attachment(shortcutInput) }, 'Text from Image')),
    () => setVariable('Trip', action('detect.text', { WFInput: attachment(shortcutInput) }, 'Text')),
  );

  comment(
    `The chat reads ${max} characters with room for its questions; a whole confirmation email can be longer. Tidy spaces ` +
      'and blank lines, then cut whatever is still over at a line break.',
  );
  const tidy = (pattern, replacement) =>
    setVariable(
      'Trip',
      action(
        'text.replace',
        { WFInput: text(variable('Trip')), WFReplaceTextFind: pattern, WFReplaceTextReplace: replacement, WFReplaceTextRegularExpression: true, WFReplaceTextCaseSensitive: true },
        'Updated Text',
      ),
    );
  // Line breaks with any spaces around them become one; then runs of other spaces become one. (A replacement is a
  // template, where "\n" means "n", so the line break is a real one.)
  tidy('\\s*\\n\\s*', '\n');
  tidy('[^\\S\\n]+', ' ');
  const length = action('count', { Input: attachment(variable('Trip')), WFCountType: 'Characters' }, 'Count');
  ifThen(isGreaterThan(length, MAX_TRIP), () => {
    // The longest start of the trip that ends at a line break between MIN_CUT and MAX_TRIP characters, else MAX_TRIP.
    // Only text over MAX_TRIP goes through it, since it would also trim text under MAX_TRIP to its last line break.
    const matches = action(
      'text.match',
      { text: text(variable('Trip')), WFMatchTextPattern: `^(?:[\\s\\S]{${MIN_CUT},${MAX_TRIP}}(?=\\n)|[\\s\\S]{0,${MAX_TRIP}})`, WFMatchTextCaseSensitive: true },
      'Matches',
    );
    setVariable('Trip', action('getitemfromlist', { WFInput: attachment(matches), WFItemSpecifier: 'First Item' }, 'Item from List'));
  });

  comment('Open the chat with the trip in its message box. After #, the text stays in the browser.');
  const encoded = action('urlencode', { WFInput: text(variable('Trip')), WFEncodeMode: 'Encode' }, 'URL Encoded Text');
  const url = action('url', { WFURLActionURL: text(`${origin}/#trip=`, encoded) }, 'URL');
  action('openurl', { WFInput: attachment(url) });

  const workflow = {
    WFWorkflowClientVersion: '5203.0.1',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    // Electric blue, with the glyph of the first Route Replay shortcut.
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59648 },
    WFWorkflowInputContentItemClasses: ['WFStringContentItem', 'WFRichTextContentItem', 'WFPDFContentItem', 'WFImageContentItem', 'WFGenericFileContentItem'],
    WFWorkflowOutputContentItemClasses: [],
    // Share Sheet, Quick Actions (Services on selected text, and Finder), and what's on screen when Siri runs it.
    WFWorkflowTypes: ['ActionExtension', 'QuickActions', 'ReceivesOnScreenContent'],
    WFQuickActionSurfaces: ['Services', 'Finder'],
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowActions: actions,
  };
  check(workflow);
  return workflow;
}

/** Every reference must point at an earlier action's output or a variable already set, and every block must close. */
function check(workflow) {
  const outputs = new Set();
  const variables = new Set();
  const open = [];
  const refs = (value, found = []) => {
    if (Array.isArray(value)) for (const v of value) refs(v, found);
    else if (value && typeof value === 'object') {
      // A condition's subject is also typed "Variable", but wraps the reference instead of naming one.
      if (value.Type === 'ActionOutput' || (value.Type === 'Variable' && 'VariableName' in value)) found.push(value);
      for (const v of Object.values(value)) refs(v, found);
    }
    return found;
  };
  for (const [i, { WFWorkflowActionIdentifier: id, WFWorkflowActionParameters: p }] of workflow.WFWorkflowActions.entries()) {
    for (const r of refs(p)) {
      const known = r.Type === 'ActionOutput' ? outputs.has(r.OutputUUID) : variables.has(r.VariableName);
      if (!known) throw new Error(`Action ${i} (${id}) refers to ${r.OutputName ?? r.VariableName}, which isn't set before it.`);
    }
    if (p.GroupingIdentifier) {
      if (p.WFControlFlowMode === 0) open.push(p.GroupingIdentifier);
      else if (open.at(-1) !== p.GroupingIdentifier) throw new Error(`Action ${i} (${id}) closes a block that isn't the innermost open one.`);
      if (p.WFControlFlowMode === 2) open.pop();
    }
    if (p.UUID) outputs.add(p.UUID);
    if (id === 'is.workflow.actions.setvariable') variables.add(p.WFVariableName);
  }
  if (open.length) throw new Error(`${open.length} block(s) never close.`);
}

function parseArgs(argv) {
  const args = { origin: 'https://routereplay.video', local: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') args.local = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--origin') args.origin = argv[++i] ?? '';
    else throw new Error(`Unknown argument ${a}. Use --local, --origin <url> or --no-open.`);
  }
  if (args.local) args.origin = execFileSync('portless', ['get', 'routereplay'], { encoding: 'utf8' }).trim();
  const url = new URL(args.origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${args.origin} isn't HTTPS. The trip would travel in the clear.`);
  }
  args.origin = url.origin;
  return args;
}

function main() {
  if (process.platform !== 'darwin') throw new Error('Building the shortcut needs macOS: it is signed with the `shortcuts` command.');
  const args = parseArgs(process.argv.slice(2));
  // Shortcuts names an imported shortcut after its file, dropping a final "(…)", so each build gets a name of its own
  // without parentheses; Siri tells them apart by name.
  const name = args.origin === 'https://routereplay.video' ? 'Route Replay' : args.local ? 'Route Replay Local' : `Route Replay ${new URL(args.origin).host}`;
  const dir = resolve('.cache/shortcut');
  mkdirSync(dir, { recursive: true });
  const json = join(dir, 'workflow.json');
  const unsigned = join(dir, 'unsigned.shortcut');
  const signed = join(dir, `${name}.shortcut`);

  writeFileSync(json, JSON.stringify(buildWorkflow({ origin: args.origin }), null, 2));
  execFileSync('plutil', ['-convert', 'binary1', '-o', unsigned, json]);
  rmSync(signed, { force: true });
  try {
    execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`Signing failed. Signing needs this Mac signed in to an Apple Account with iCloud.\n${e.stderr ?? e.message}`);
  }
  console.log(`Built "${name}" for ${args.origin}:\n  ${signed}`);
  if (args.open) {
    execFileSync('open', [signed]);
    console.log('Shortcuts is open: choose Add Shortcut (or Replace, for a rebuild).');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
