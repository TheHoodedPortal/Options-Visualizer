export function isRateLimit(error) {
  if (error?.code === 'rate_limited') return true;
  const message = String(error?.message || error);
  return /too many requests|rate[ -]?limit|(?:http(?:\s+error)?|status(?:\s+code)?|error|code)\s*[:=]?\s*429\b/i.test(message);
}
