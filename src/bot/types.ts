// Types for the public RopeDrop bot data bundle, schema v1 (the fields this
// app reads). Unknown fields are ignored, as the schema requires.

export type Dest = 'wdw' | 'dlr' | 'dlp' | 'tdr' | 'hkdl' | 'shdr';
export const DESTS: readonly Dest[] = [
  'wdw',
  'dlr',
  'dlp',
  'tdr',
  'hkdl',
  'shdr',
];

/** [avg_or_p50_minutes, samples_or_days] or null. */
export type Cell = [number, number] | null;

export type Header = {
  schema: string;
  schema_version: number;
  kind: string;
  generated_at: string;
  dest?: string;
  tz?: string;
  local_date?: string;
};

export type ManifestFile = {
  path: string;
  kind: string;
  dest?: string | null;
  bytes: number;
  sha256: string;
};

export type Manifest = {
  schema: string;
  schema_version: number;
  generated_at: string;
  generation: string;
  base_url: string;
  site?: string;
  common: string;
  destinations: Record<
    string,
    {
      name?: string;
      tz?: string;
      local_date?: string;
      files: {
        core?: string;
        events?: string;
        ll?: string;
        daw?: string;
        menus?: string[];
        posts?: string;
        /** Ticketed parties / After Hours (wdw, dlr; added 2026-10-26). */
        parties?: string;
        /** Every menu row with its current / not-seen-since status (wdw, dlr; added 2026-10-26). */
        menu_items?: string[];
      };
    }
  >;
  files: ManifestFile[];
  total_bytes?: number;
};

export type Common = Header & {
  destinations: Record<
    string,
    {
      name: string;
      tz: string;
      currency: string;
      currency_symbol: string;
      parks: { slug: string; name: string }[];
    }
  >;
  destination_keywords: [string, string[]][];
  park_aliases: Record<string, [string, string]>;
  ride_aliases: Record<string, Record<string, string>>;
  closed_attractions: string[];
  closed_attractions_destinations: string[];
  crowd_labels: { low_max: number; high_min: number };
  fuzzy_threshold: number;
  notes: { predictions: string; hours: string; waits: string };
};

export type Ride = {
  name: string;
  norm: string;
  variants: string[];
  slug: string | null;
  park: string | null;
  land?: string | null;
  ride_type?: string | null;
  indoor: boolean | null;
  height_min_in: number | null;
  height_max_in: number | null;
  no_min_height: boolean;
  kids_only: boolean;
  ll: string | null;
  rain: {
    sensitive: boolean;
    ratio: number | null;
    wet_rate_per_100h: number | null;
    dry_rate_per_100h: number | null;
    wet_median_min?: number | null;
    dry_median_min?: number | null;
    wet_hours?: number | null;
  } | null;
  urls: {
    page?: string | null;
    best_time?: string;
    wait_times?: string;
    lightning_lane?: string;
  };
  waits: { hour: Cell[]; dow: Cell[]; dow_hour: Cell[][] } | null;
  rush: {
    open?: Partial<Record<'weekday' | 'weekend' | 'all', Cell[]>>;
    ee?: Partial<Record<'weekday' | 'weekend' | 'all', Cell[]>>;
  } | null;
};

export type Restaurant = {
  name: string;
  norm: string;
  variants: string[];
  slug: string | null;
  park: string | null;
  location?: string | null;
  type?: string | null;
  service?: string | null;
  reservations?: boolean | null;
  walk_up?: boolean | null;
  url: string;
  menu_url: string | null;
  menu_part: number | null;
};

export type Show = {
  name: string;
  norm: string;
  variants: string[];
  type: string;
  slug: string | null;
  park: string | null;
  url: string;
};

export type Span = {
  open: string;
  close: string;
  open24?: string;
  close24?: string;
};

export type Hours = {
  open: string | null;
  close: string | null;
  open24?: string | null;
  close24?: string | null;
  early_entry: Span | null;
  extended_evening: Span | null;
  extras: (Span & { type: string; name: string })[];
};

export type Crowd = {
  level: number;
  label: string;
  avg_wait: number;
  confidence: string;
  seasonal: string[];
};

export type Pick = {
  id?: string | null;
  ride: string;
  avg_wait_at_open_min: number;
  typical_peak_wait_min: number;
  minutes_saved_vs_peak: number;
};

export type Outlook = {
  weekday: number;
  rope_drop: Pick[];
  early_entry_picks: Pick[];
  peak: {
    start: string;
    end: string;
    start_hour: number;
    end_hour: number;
    avg_headliner_wait_min: number;
  } | null;
  quieter: {
    start: string;
    end: string;
    start_hour: number;
    avg_headliner_wait_min: number;
  } | null;
};

export type Holiday = {
  name: string;
  kind: string;
  region?: string | null;
  start: string;
  end: string;
  days_with_data?: number;
  avg_wait?: number;
  baseline_wait?: number;
  pct?: number;
  status?: string;
  note?: string | null;
};

export type Pattern = {
  scope: string;
  url: string;
  profile: {
    window_days: number;
    days: number;
    first_date: string;
    last_date: string;
    by_dow: { dow: number; day: string; avg_wait: number; days: number }[];
    quietest: string;
    busiest: string;
    best_weekday: string;
    worst_weekday: string;
    weekday_avg: number;
    weekend_avg: number;
    weekend_vs_weekday_pct: number;
  } | null;
  headline: string | null;
  verdict: string | null;
  faq: { q: string; a: string }[];
  holiday_impact: Holiday[];
  upcoming_holidays: Holiday[];
};

export type RainPark = {
  window_start: string;
  window_end: string;
  open_hours: number;
  wet_hours: number;
  wet_rate_per_100_ride_hours: number;
  dry_rate_per_100_ride_hours: number;
  small_sample: boolean;
  sensitive: { id: string; name: string; ratio: number | null }[];
};

export type Core = Header & {
  dest: Dest;
  tz: string;
  local_date: string;
  name: string;
  urls: Record<string, string | null>;
  parks: Record<
    string,
    { name: string; uuid?: string | null; urls: Record<string, string> }
  >;
  rides: Record<string, Ride>;
  ride_aliases: Record<string, string>;
  intl_ride_aliases: Record<string, string>;
  restaurants: Record<string, Restaurant>;
  shows: Record<string, Show>;
  hours: Record<string, { url: string; days: Record<string, Hours> }>;
  crowds: Record<string, { url: string; days: Record<string, Crowd> }>;
  outlook: Record<string, { url: string; days: Record<string, Outlook> }>;
  crowd_patterns: Record<string, Pattern>;
  rain: { url: string; parks: Record<string, RainPark> } | null;
};

export type SpecialEvent =
  | {
      kind: 'ticketed_event' | 'extra_hours' | 'extended_evening';
      name: string;
      park: string;
      likely_event: string | null;
      dates: { date: string; open: string; close: string }[];
    }
  | {
      kind: 'seasonal';
      name: string;
      park: string;
      type?: string;
      start: string;
      end: string;
      url?: string;
    };

export type ClosureItem = {
  id: string;
  name: string;
  park: string | null;
  url?: string | null;
};

export type Events = Header & {
  urls: { special_events: string; closures: string };
  special_events: SpecialEvent[];
  closures: {
    as_of: string;
    url: string;
    note?: string;
    refurbishment: ClosureItem[];
    not_operating_24h: ClosureItem[];
  };
};

export type SellTime = {
  median: string;
  earliest: string;
  latest: string;
  days: number;
} | null;

export type LL = Header & {
  currency: string;
  urls: {
    pricing: string;
    price_by_month: string;
    should_i_buy: string;
    sellout: string;
  };
  prices: Record<
    string,
    Record<
      string,
      {
        multipass: number | null;
        multipass_status: string;
        checked: string | null;
        single_pass: {
          id: string;
          name: string;
          price: number | null;
          available: boolean;
        }[];
        single_pass_checked?: string | null;
        premier: number | null;
      }
    >
  >;
  sellout: {
    timezone: string;
    tz_label: string;
    first_date: string;
    last_date: string;
    tracked_days: number;
    multipass_since?: string | null;
    rides: {
      id: string;
      name: string;
      park: string | null;
      typical_price: number | null;
      tracked_days: number;
      offered_days: number;
      gone_days: number;
      gone_pct: number;
      sellout_time: SellTime;
      by_dow: {
        day: string;
        offered_days: number;
        gone_pct: number | null;
        median: string | null;
      }[];
    }[];
    multipass: {
      park: string;
      park_name: string;
      offered_days: number;
      gone_days: number;
      gone_pct: number;
      sellout_time: SellTime;
      by_dow: {
        day: string;
        offered_days: number;
        gone_pct: number | null;
        median: string | null;
      }[];
    }[];
  } | null;
};

export type DAW = Header & {
  url: string;
  total: {
    low: number | null;
    high: number | null;
    display: string | null;
    priced_count: number;
    menu_count: number;
    estimate_count: number;
    checked: string | null;
  };
  pavilions: {
    slug: string;
    name: string;
    url: string;
    signature: {
      name: string;
      price_estimate?: string | null;
      price: {
        source: string;
        display: string;
        checked_display?: string | null;
      } | null;
    } | null;
    drinks_count: number;
    walk_up_count: number;
  }[];
};

export type MenuFile = Header & {
  currency: string;
  fresh_days: number;
  restaurants: Record<
    string,
    {
      name: string;
      park: string | null;
      url: string;
      checked: string | null;
      periods: Record<string, Record<string, [string, number | null][]>>;
    }
  >;
};

/** [date, adult price, child price, sold out] (prices before tax; null = not captured). */
export type PartyNight = [string, number | null, number | null, boolean | null];
/** [kind, name, location] — kind: character|show|parade|fireworks|ride|treat|dining|venue. */
export type PartyOffering = [string, string, string | null];
/** [disney entity id, name, entity kind, night, start "HH:MM", end "HH:MM" | null]. */
export type PartyShowtime = [
  string,
  string,
  string | null,
  string,
  string,
  string | null,
];

export type PartyEvent = {
  name: string;
  kind: string;
  park: string | null;
  ticketed: boolean;
  start: string | null;
  end: string | null;
  early_entry: string | null;
  price_min: number | null;
  price_max: number | null;
  status_note: string | null;
  /** Park-local date of the capture that last saw the event. */
  seen: string | null;
  /** Our /{dest}/special-events/{slug} page (null when the site has none). */
  url: string | null;
  series_url: string | null;
  nights: PartyNight[];
  offerings: PartyOffering[];
  showtimes: PartyShowtime[];
};

/** parties.json (wdw, dlr; added 2026-10-26, optional). */
export type Parties = Header & {
  captured_at: string | null;
  urls: { special_events: string };
  events: Record<string, PartyEvent>;
  /** Characters the regular-day character locator lists (not party-only). */
  regular_characters: string[];
};

/** [item name, price | null, status c|g|u, last_seen park-local "YYYY-MM-DDTHH:MM" | null]. */
export type MenuItemRow = [
  string,
  number | null,
  'c' | 'g' | 'u',
  string | null,
];

/** menu_items.json / menu_items-NN.json (wdw, dlr; added 2026-10-26, optional). */
export type MenuItemsFile = Header & {
  part: number;
  parts: number;
  currency: string;
  resort_newest: string | null;
  links: {
    snack_tour: Record<string, { title: string; url: string }>;
    food_prices: { title: string; url: string } | null;
  };
  stands: Record<
    string,
    {
      name: string;
      area: string;
      place: string | null;
      menu_url: string | null;
      items: MenuItemRow[];
    }
  >;
};

/** One ready-to-post weekly post (server-built and fact-checked; see DSNY app/services/bot_weekly.py). */
export type WeeklyPost = {
  ok: boolean;
  reason?: string | null;
  /** Park-local YYYY-MM-DD the post was built for. */
  date: string | null;
  title: string | null;
  markdown: string | null;
};

export type WeeklyKind = 'weekly_questions' | 'weekly_changes';

/** posts.json (wdw, dlr only; added 2026-10-24, optional). */
export type Posts = {
  kind: 'posts';
  dest: Dest;
  generated_at: string;
} & Partial<Record<WeeklyKind, WeeklyPost>>;

/** Read access to one bundle generation. Every getter may reject. */
export interface BundleSource {
  generation(): Promise<string>;
  common(): Promise<Common>;
  core(dest: Dest): Promise<Core | null>;
  events(dest: Dest): Promise<Events | null>;
  ll(dest: Dest): Promise<LL | null>;
  daw(dest: Dest): Promise<DAW | null>;
  menus(dest: Dest, part: number): Promise<MenuFile | null>;
  menuParts(dest: Dest): Promise<number>;
  /** Weekly posts; absent in bundles from before 2026-10-24. */
  posts?(dest: Dest): Promise<Posts | null>;
  /** Ticketed parties; absent (null) in bundles from before 2026-10-26. */
  parties?(dest: Dest): Promise<Parties | null>;
  /** Menu rows with status; 0 parts in bundles from before 2026-10-26. */
  menuItems?(dest: Dest, part: number): Promise<MenuItemsFile | null>;
  menuItemParts?(dest: Dest): Promise<number>;
}
