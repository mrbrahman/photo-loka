// Client-side helpers for the timeline view.
//
// Each item from the server now carries albumDate and albumName as separate
// fields, so all the path-stripping logic from earlier phases is gone. The
// helpers here are about presentation (time / day formatting, time window),
// detection (placeholder match), and grouping (consecutive vs all-by-album
// within a day).

/**
 * True if the album name matches the collection's placeholder text. Treats
 * empty placeholder as never matching. For nested album names (a/b/c) we
 * match if any path segment equals the placeholder - that's a folder that
 * still needs review somewhere in its hierarchy.
 */
export function isPlaceholder(albumName, placeholder) {
  if (!placeholder || !albumName) return false;
  return albumName.split('/').includes(placeholder);
}

/**
 * Format a local time string ('HH:MM') as 'h:mma' (e.g. '5:00pm', '12:30am').
 */
export function formatTime(localTime) {
  if (!localTime) return '';
  const [hStr, mStr] = localTime.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr;
  const period = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m}${period}`;
}

/**
 * Format a time window from a list of items. Items have data.t (epoch seconds),
 * data.localTime ('HH:MM' in photographer's timezone), data.tzOffset ('+HH:MM'
 * or null), data.tzName (IANA timezone name or null), and data.hasTime (0/1).
 * Returns:
 *   - 'h:mma ← h:mma' (latest ← earliest) when displayed times differ
 *   - 'h:mma EST ← h:mma IST' when offsets differ (uses abbreviation if available)
 *   - 'h:mma' when displayed times are the same
 *   - '(no time)' when no items have a real capture time
 *
 * Uses U+2190 (left arrow) here intentionally - exception to the project's
 * ASCII-only rule for source files since the arrow is a clearer visual
 * direction cue than ASCII '<-'.
 */
export function formatTimeWindow(items) {
  const timed = items.filter(i => i.data?.hasTime && i.data.localTime);
  if (timed.length === 0) return '(no time)';

  // Find earliest and latest by epoch (true chronological order)
  let minItem = timed[0], maxItem = timed[0];
  for (const item of timed) {
    if (item.data.t < minItem.data.t) minItem = item;
    if (item.data.t > maxItem.data.t) maxItem = item;
  }

  const minStr = formatTime(minItem.data.localTime);
  const maxStr = formatTime(maxItem.data.localTime);

  // Show timezone only when earliest and latest are in different timezones
  const showTz = minItem.data.tzOffset && maxItem.data.tzOffset
    && minItem.data.tzOffset !== maxItem.data.tzOffset;

  if (minStr === maxStr && !showTz) return minStr;

  const maxTz = showTz ? ' ' + formatTzLabel(maxItem.data.tzName, maxItem.data.tzOffset, maxItem.data.t) : '';
  const minTz = showTz ? ' ' + formatTzLabel(minItem.data.tzName, minItem.data.tzOffset, minItem.data.t) : '';
  return `${maxStr}${maxTz} \u2190 ${minStr}${minTz}`;
}

/**
 * Get a timezone display label. Prefers abbreviation from IANA name (e.g. 'EST')
 * via Intl.DateTimeFormat; falls back to numeric offset (e.g. '+05:30').
 */
function formatTzLabel(tzName, tzOffset, epochSec) {
  if (tzName) {
    try {
      const abbrev = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        timeZoneName: 'short'
      }).formatToParts(new Date(epochSec * 1000))
        .find(p => p.type === 'timeZoneName')?.value;
      if (abbrev) return abbrev;
    } catch { /* invalid tzName, fall through */ }
  }
  return tzOffset || '';
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Format a 'YYYY-MM-DD' day key as 'Wed, Oct 22, 2025'.
 * Special case: 'YYYY-MM-DD' = '1970-01-01' renders as 'Date Unknown' since
 * that's the indexer's sentinel for items with no derivable date.
 */
export function formatDayHeader(dayKey) {
  if (dayKey === '1970-01-01') return 'Date Unknown';
  const [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(y, m - 1, d);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
  const monthName = date.toLocaleDateString('en-US', { month: 'short' });
  return `${dayName}, ${monthName} ${d}, ${y}`;
}

/**
 * Walk a day's items and form album sub-groups by consecutive same-album
 * (by albumName). Two birthday clusters at different times of day form
 * two distinct groups, preserving timeline order.
 * Returns: [{albumName, items: [...]}, ...]
 */
export function groupConsecutiveByAlbum(items) {
  const groups = [];
  let curr = null;
  for (const item of items) {
    if (!curr || curr.albumName !== item.albumName) {
      curr = { albumName: item.albumName, items: [] };
      groups.push(curr);
    }
    curr.items.push(item);
  }
  return groups;
}

/**
 * Group all items in a day by albumName, irrespective of time. Used for the
 * per-day "folder mode" toggle. Returns: [{albumName, items: [...]}, ...]
 * sorted alphabetically by albumName.
 */
export function groupAllByAlbum(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.albumName || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([albumName, items]) => ({ albumName, items }));
}
