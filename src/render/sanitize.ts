const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeTerminal(text: string): string {
  return text.replace(CONTROL_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
