/**
 * Redact common secret patterns before writing AI request logs to disk.
 */
export function maskSensitiveText(text = '') {
  return String(text)
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9._\-+/=]{8,})/gi, '$1***')
    .replace(/(authorization["'\s:=]+bearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi, '$1***')
    .replace(/(x-api-key["'\s:=]+)([A-Za-z0-9._\-+/=]{8,})/gi, '$1***')
    .replace(/(["']?(?:password|passwd|secret|token|private[_-]?key)["'\s:=]+)([^\s"'\\,}\]]{4,})/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9]{8,})\b/g, 'sk-***')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, 'AKIA***')
    .replace(/([?&](?:key|token|access_token|api_key)=)([^&\s"']+)/gi, '$1***')
    .replace(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----');
}
