#!/usr/bin/env node
/**
 * Build the versioned airport lookup used by the API for normalization.
 *
 * Sources (see docs/assets.md for licenses):
 *   - OurAirports airports.csv (public domain): codes, names, coordinates, service flags.
 *   - mwgg/Airports airports.json (MIT): IANA time zones keyed by ICAO/IATA.
 *   - @photostructure/tz-lookup (CC0): coordinate-based fallback for missing time zones.
 *
 * Usage: node scripts/build-airports.mjs [--cache .cache/airports]
 * Writes src/server/airports/airports.json.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import tzlookup from '@photostructure/tz-lookup';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cacheArg = process.argv.indexOf('--cache');
const cacheDir = path.resolve(root, cacheArg > 0 ? process.argv[cacheArg + 1] : '.cache/airports');
const SOURCES = {
  ourairports: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
  mwgg: 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json',
};

async function cached(name, url) {
  const file = path.join(cacheDir, name);
  try {
    await access(file);
  } catch {
    process.stderr.write(`Downloading ${url}\n`);
    const res = await fetch(url, { headers: { 'user-agent': 'routereplay-web airport build script' } });
    if (!res.ok) throw new Error(`Download failed: ${url} ${res.status}`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(file);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const csvBuf = await cached('ourairports-airports.csv', SOURCES.ourairports);
const mwggBuf = await cached('mwgg-airports.json', SOURCES.mwgg);
const sourceHash = createHash('sha256').update(csvBuf).update(mwggBuf).digest('hex').slice(0, 12);

const mwgg = JSON.parse(mwggBuf.toString('utf8'));
const byIcao = new Map();
const byIata = new Map();
for (const v of Object.values(mwgg)) {
  if (v.icao) byIcao.set(v.icao, v);
  if (v.iata && !byIata.has(v.iata)) byIata.set(v.iata, v);
}

const rows = parseCsv(csvBuf.toString('utf8'));
const keepTypes = new Set(['large_airport', 'medium_airport', 'small_airport', 'seaplane_base']);
const out = new Map();
let fallback = 0;
for (const r of rows) {
  const code = r.iata_code;
  if (!/^[A-Z]{3}$/.test(code) || !keepTypes.has(r.type)) continue;
  const scheduled = r.scheduled_service === 'yes';
  if (!scheduled && r.type !== 'large_airport' && r.type !== 'medium_airport') continue;
  const lat = Number(r.latitude_deg);
  const lon = Number(r.longitude_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const match = byIcao.get(r.ident) || byIcao.get(r.icao_code) || byIata.get(code);
  let tz = match?.tz;
  if (!tz || !validZone(tz)) {
    tz = tzlookup(lat, lon);
    fallback++;
  }
  if (!validZone(tz)) continue;
  const rank = (scheduled ? 10 : 0) + (r.type === 'large_airport' ? 3 : r.type === 'medium_airport' ? 2 : 1);
  const prev = out.get(code);
  if (prev && prev.rank >= rank) continue;
  out.set(code, {
    rank,
    row: [code, r.name, r.municipality || '', r.iso_country, Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, tz],
  });
}

const codes = [...out.keys()].sort();
const today = new Date().toISOString().slice(0, 10);
const data = {
  version: `${today}.${sourceHash}`,
  sources: [
    'OurAirports airports.csv (public domain), https://ourairports.com/data/',
    'mwgg/Airports airports.json (MIT License), https://github.com/mwgg/Airports',
    '@photostructure/tz-lookup (CC0) for missing time zones',
  ],
  fields: ['code', 'name', 'city', 'country', 'lat', 'lon', 'timeZone'],
  rows: codes.map((c) => out.get(c).row),
};
const target = path.join(root, 'src/server/airports/airports.json');
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(data) + '\n');
process.stderr.write(`Wrote ${codes.length} airports (${fallback} time zones from coordinates) to ${path.relative(root, target)}\n`);
