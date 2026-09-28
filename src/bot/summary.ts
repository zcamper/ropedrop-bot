// "Today's Crowd Outlook" daily post, ported from the backend's
// bot_summary.py and built from the bundle: crowd level (crowds), hours,
// rope-drop pick and busy/quieter windows (outlook) for each park, for the
// destination's park-local today. Missing pieces render as "—", never invented.

import { getCrowd, getHours, getOutlook } from './answer.js';
import { parkDisplayName, parkSlugs } from './parse.js';
import type { Common, Core, Dest } from './types.js';
import { fmtDay, type Day } from './util.js';

type ParkEntry = {
  name: string;
  crowd: { level: number; label: string } | null;
  hours: {
    open: string | null;
    close: string | null;
    early_entry: { open: string } | null;
  } | null;
  pick: string | null;
  peak: { start: string; end: string } | null;
  quieter: { start: string; end: string } | null;
};

function parkEntry(
  common: Common,
  core: Core,
  dest: Dest,
  park: string,
  day: Day
): ParkEntry {
  const c = getCrowd(core, park, day);
  const h = getHours(core, park, day);
  const o = getOutlook(core, park, day);
  return {
    name: parkDisplayName(common, dest, park),
    crowd: c ? { level: c.crowd_level, label: c.label } : null,
    hours: h
      ? { open: h.open, close: h.close, early_entry: h.early_entry }
      : null,
    pick: o?.rope_drop[0]?.ride ?? null,
    peak: o?.peak ? { start: o.peak.start, end: o.peak.end } : null,
    quieter:
      o?.peak && o.quieter
        ? { start: o.quieter.start, end: o.quieter.end }
        : null,
  };
}

function cell(text: string | null): string {
  return (text || '—').replace(/\|/g, '/');
}

/** bot_summary.render_markdown: "## title" line, table, bullets, note. */
export function renderDailyMarkdown(
  common: Common,
  core: Core,
  dest: Dest,
  day: Day
): string | null {
  const parks = parkSlugs(common, dest).map((p) =>
    parkEntry(common, core, dest, p, day)
  );
  if (!parks.some((p) => p.crowd || p.hours || p.pick)) return null;
  const lines = [
    `## Today's Crowd Outlook — ${fmtDay(day)}`,
    '',
    '| Park | Crowd | Hours | Rope-drop pick |',
    '|---|---|---|---|',
  ];
  for (const p of parks) {
    const crowd = p.crowd ? `${p.crowd.level}/10 (${p.crowd.label})` : null;
    let hours: string | null = null;
    if (p.hours?.open && p.hours.close) {
      hours = `${p.hours.open} – ${p.hours.close}`;
      if (p.hours.early_entry?.open)
        hours += ` (Early Entry ${p.hours.early_entry.open})`;
    }
    lines.push(
      `| ${cell(p.name)} | ${cell(crowd)} | ${cell(hours)} | ${cell(p.pick)} |`
    );
  }
  const bullets: string[] = [];
  for (const p of parks) {
    const bits: string[] = [];
    if (p.peak) bits.push(`busiest ~${p.peak.start}–${p.peak.end}`);
    if (p.quieter) bits.push(`quieter ~${p.quieter.start}–${p.quieter.end}`);
    if (bits.length) bullets.push(`* **${p.name}:** ${bits.join('; ')}`);
  }
  if (bullets.length) lines.push('', ...bullets);
  lines.push(
    '',
    `*${common.notes.predictions}* Full forecasts: [crowd calendar](${core.urls.crowd_calendar})`
  );
  return lines.join('\n');
}
