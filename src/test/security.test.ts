import assert from 'assert';
import { describe, it } from 'node:test';
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m] as string);
}

describe('HTML Escaping', () => {
  it('escapes special characters', () => {
    const result = escapeHtml('<script>alert("x")</script>');
    assert.strictEqual(result, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
