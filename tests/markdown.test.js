const test = require('node:test');
const assert = require('node:assert/strict');
test('markdown rendering escapes unsafe content and preserves formatting', () => {
  const {renderMarkdown} = require('../js/app/markdown.js');
  assert.match(
    renderMarkdown('# T\n\n**b** _i_ `<x>`'),
    /<h1>T<\/h1><p><strong>b<\/strong> <em>i<\/em> <code>&lt;x&gt;<\/code><\/p>/
  );
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) ![i](https://e.com/a.png)'), /<img|href="javascript/);
  assert.match(
    renderMarkdown('[x](https://e.com)'),
    /<a href="https:\/\/e\.com" target="_blank" rel="noopener noreferrer">x<\/a>/
  );
  assert.match(
    renderMarkdown('- a\n  - b\n- [x] c'),
    /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li><span class="md-task">☑<\/span> c<\/li><\/ul>/
  );
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th>/);
});

test('markdownSlug names Settings sections; a note gets no page links and no images', () => {
  const {renderMarkdown, markdownSlug} = require('../js/app/markdown.js');
  assert.equal(markdownSlug('Keyboard shortcuts'), 'keyboard-shortcuts');
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1)) <script>x</script>'), /<script|href="javascript/);
  assert.doesNotMatch(renderMarkdown('[a](/x) ![i](docs/a.png)'), /<a |<figure|<img/);
});
