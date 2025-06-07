import * as assert from 'assert';
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m] as string);
}

suite('HTML Escaping', () => {
  test('escapes special characters', () => {
    const result = escapeHtml('<script>alert("x")</script>');
    assert.strictEqual(result, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
