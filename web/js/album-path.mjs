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
 * Format a unix epoch (seconds) as 'h:mma' (e.g. '5:00pm', '12:30am').
 */
export function formatTime(epochSec) {
  const d = new Date(epochSec * 1000);
  let h = d.getHours();
  const m = d.getMinutes();
  const period = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')}${period}`;
}

/**
 * Format a time window from a list of items. Items have data.t (epoch seconds)
 * and data.hasTime (0/1). Returns:
 *   - 'h:mma ← h:mma' (latest ← earliest) when displayed times differ
 *   - 'h:mma' when displayed times are the same (same h:mm, even if seconds
 *     differ - we don't render seconds, so '8:04pm <- 8:04pm' would be noise)
 *   - '(no time)' when no items have a real capture time
 *
 * Uses U+2190 (left arrow) here intentionally - exception to the project's
 * ASCII-only rule for source files since the arrow is a clearer visual
 * direction cue than ASCII '<-'.
 */
export function formatTimeWindow(items) {
  const timed = items.filter(i => i.data?.hasTime);
  if (timed.length === 0) return '(no time)';

  const times = timed.map(i => i.data.t);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const minStr = formatTime(min);
  const maxStr = formatTime(max);
  return minStr === maxStr ? minStr : `${maxStr} ← ${minStr}`;
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
