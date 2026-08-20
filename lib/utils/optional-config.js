/**
 * 可选配置：用户显式传入才生效。
 * 未传 / 空值 / 非数字 → undefined，调用方不设限制、不发给模型。
 */
export function resolveOptionalNumber(...candidates) {
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

export function resolveOptionalPositiveInt(...candidates) {
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return undefined;
}
