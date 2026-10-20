const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeTerminal(text: string): string {
  return text.replace(CONTROL_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function sanitizeJson(json: string): string {
  return json.replace(CONTROL_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
