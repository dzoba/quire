// Output size for the compressor (maximum width/height, never enlarges) and the resizer
// (exact width/height or a percentage, may enlarge). Pure functions, also used by the Node tests.

const px = n => Math.max(1, Math.round(n));

// Compressor: shrink to fit inside maxW x maxH (0 = no limit), never enlarge.
export function fitWithin(w, h, maxW, maxH) {
  let s = 1;
  if (maxW > 0 && w > maxW) s = Math.min(s, maxW / w);
  if (maxH > 0 && h > maxH) s = Math.min(s, maxH / h);
  return {width: px(w * s), height: px(h * s)};
}

// Resizer.
//   {mode: 'percent', percent}                    both sides times percent / 100
//   {mode: 'size', width, height, keepRatio: true} one side given: the other follows the ratio;
//                                                  both given: the largest size that fits inside
//   {mode: 'size', width, height, keepRatio: false} exactly width x height (a missing side stays as it is)
export function resizeTarget(w, h, r) {
  if (r.mode === 'percent') {
    if (!(r.percent > 0)) throw new Error('Enter a percentage above 0.');
    return {width: px(w * r.percent / 100), height: px(h * r.percent / 100)};
  }
  const W = r.width > 0 ? r.width : 0, H = r.height > 0 ? r.height : 0;
  if (!W && !H) throw new Error('Enter a width, a height, or both.');
  if (!r.keepRatio) return {width: W || w, height: H || h};
  if (W && !H) return {width: W, height: px(h * W / w)};
  if (H && !W) return {width: px(w * H / h), height: H};
  const s = Math.min(W / w, H / h);
  // Round the side that limits to the exact number entered.
  return W / w <= H / h ? {width: W, height: px(h * s)} : {width: px(w * s), height: H};
}
