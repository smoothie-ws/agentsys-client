const test=require('node:test'), assert=require('node:assert/strict');
test('the static client sends framing and content policies', async () => {
  await require('./client-harness').withClient(async ({base}) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self' blob:/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  });
});

