export function fmtTime(ms) {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)} s`;
  return `${(ms/1000/60).toFixed(1)} min`;
}
