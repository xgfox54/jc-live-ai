export function delayTarget(first, second, observationSeconds = 1.5) {
  if (![first, second, observationSeconds].every(Number.isFinite) || observationSeconds < 0 || observationSeconds > 12
    || first < 30 || second - first < 0.5 || second - first > observationSeconds + 2.5) return null;
  return second - 30;
}

export function verifyDelay(edge, time) {
  if (![edge, time].every(Number.isFinite)) return { supported: false, error_s: null };
  const error = Math.abs(edge - time - 30);
  return { supported: error <= 2, error_s: error };
}
