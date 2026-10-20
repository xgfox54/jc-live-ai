export function toggleSelection(current, id, available) {
  if (current.includes(id)) return { ids: current.filter(value => value !== id), limited: false };
  if (!available.includes(id)) return { ids: current, limited: false };
  if (current.length >= 2) return { ids: current, limited: true };
  return { ids: [...current, id], limited: false };
}
