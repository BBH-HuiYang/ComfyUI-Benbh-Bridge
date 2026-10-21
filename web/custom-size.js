// A normalization result is either a fully valid grid point or null. Rounding
// preferences never override aspect, area or edge constraints.
export function isValidCustomSize(width, height, rules = {}) {
  const step = rules.dimension_step || 1
  const pixels = width * height
  const ratio = width / height
  return Number.isSafeInteger(width) && width > 0 &&
    Number.isSafeInteger(height) && height > 0 &&
    Number.isSafeInteger(pixels) &&
    width % step === 0 && height % step === 0 &&
    (!rules.max_edge || Math.max(width, height) <= rules.max_edge) &&
    (!rules.min_pixels || pixels >= rules.min_pixels) &&
    (!rules.max_pixels || pixels <= rules.max_pixels) &&
    (!rules.min_aspect_ratio || ratio >= rules.min_aspect_ratio) &&
    (!rules.max_aspect_ratio || ratio <= rules.max_aspect_ratio)
}

export function roundCustomSizeDimension(value, step = 1, mode = 'nearest') {
  if (!Number.isSafeInteger(value) || value <= 0) return null
  step = step || 1
  const round = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round
  return Math.max(step, round(value / step) * step)
}

export function normalizeCustomSizePair(width, height, rules = {}) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null
  if (isValidCustomSize(width, height, rules)) return { width, height }

  const step = rules.dimension_step || 1
  const minRatio = rules.min_aspect_ratio || 0
  const maxRatio = rules.max_aspect_ratio || Infinity
  const minPixels = rules.min_pixels || 0
  const maxPixels = Math.min(rules.max_pixels || Infinity, Number.MAX_SAFE_INTEGER)
  const maxEdge = rules.max_edge || Number.MAX_SAFE_INTEGER
  if (minRatio > maxRatio || minPixels > maxPixels || maxEdge < step) return null

  // Keep the existing intent: round inputs, enlarge the short side to meet
  // aspect constraints, and scale both dimensions together at area/edge limits.
  let targetWidth = roundCustomSizeDimension(width, step, rules.round_mode)
  let targetHeight = roundCustomSizeDimension(height, step, rules.round_mode)
  if (targetWidth / targetHeight < minRatio) targetWidth = targetHeight * minRatio
  if (targetWidth / targetHeight > maxRatio) targetHeight = targetWidth / maxRatio
  const targetPixels = targetWidth * targetHeight
  const scale = Math.min(
    Math.max(1, Math.sqrt(minPixels / targetPixels)),
    Math.sqrt(maxPixels / targetPixels),
    maxEdge / Math.max(targetWidth, targetHeight)
  )
  targetWidth *= scale
  targetHeight *= scale
  if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight)) return null

  // For each width there is one legal interval of heights. Round the lower
  // bound UP and upper bound DOWN, then choose the closest height inside it.
  // This prevents the old 758 -> 752 -> 758 cycle at a 3:1 boundary.
  const maxHeight = Math.floor(Math.min(maxEdge, maxPixels / step) / step) * step
  const firstWidth = Math.max(1, Math.ceil(Math.max(minPixels / maxHeight, minRatio * step) / step) - 1)
  const lastWidth = Math.min(Math.floor(maxEdge / step),
    Math.floor(Math.min(maxPixels / step, maxHeight * maxRatio) / step) + 1)
  if (maxHeight < step || firstWidth > lastWidth) return null
  const center = Math.max(firstWidth, Math.min(lastWidth, Math.round(targetWidth / step)))
  let best = null
  let bestDistance = Infinity

  function consider(widthUnits) {
    const candidateWidth = widthUnits * step
    // Include the adjacent grid points to avoid discarding an exact boundary
    // because division/multiplication rounded a floating-point ratio outward.
    const lower = Math.max(step, candidateWidth / maxRatio, minPixels / candidateWidth)
    const upper = Math.min(maxHeight, minRatio ? candidateWidth / minRatio : Infinity, maxPixels / candidateWidth)
    let low = Math.max(1, Math.ceil(lower / step) - 1)
    let high = Math.min(Math.floor(maxHeight / step), Math.floor(upper / step) + 1)
    while (low <= high && !isValidCustomSize(candidateWidth, low * step, rules)) low += 1
    while (high >= low && !isValidCustomSize(candidateWidth, high * step, rules)) high -= 1
    if (low > high) return
    const heightUnits = Math.max(low, Math.min(high, Math.round(targetHeight / step)))
    const candidateHeight = heightUnits * step
    if (!isValidCustomSize(candidateWidth, candidateHeight, rules)) return
    const distance = (candidateWidth - targetWidth) ** 2 + (candidateHeight - targetHeight) ** 2
    if (distance < bestDistance) {
      best = { width: candidateWidth, height: candidateHeight }
      bestDistance = distance
    }
  }

  // Search outward from the target. Once width distance alone exceeds the
  // best full distance, more distant widths cannot improve the result.
  // Bound work for pathological metadata (e.g. a huge, impossible exact ratio).
  // Hitting the budget may return a validated result, never an unchecked pair.
  let remaining = 100000
  let left = center
  let right = center + 1
  while (remaining > 0) {
    const useLeft = left >= firstWidth && (left * step - targetWidth) ** 2 <= bestDistance
    const useRight = right <= lastWidth && (right * step - targetWidth) ** 2 <= bestDistance
    if (!useLeft && !useRight) break
    if (useLeft) { consider(left); left -= 1; remaining -= 1 }
    if (useRight && remaining > 0) { consider(right); right += 1; remaining -= 1 }
  }
  return best
}

export const CUSTOM_SIZE_CALIBRATION_ERROR = '当前尺寸规则下无法自动校准，请调整尺寸或切换档位'
