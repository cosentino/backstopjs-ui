const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getLastResult } = require('../lib/results');

const FIXTURE =
  'report({"testSuite":"BackstopJS","tests":[' +
  '{"pair":{"label":"Home","viewportLabel":"mobile","diff":{"misMatchPercentage":"7.81"}},"status":"fail"},' +
  '{"pair":{"label":"Home","viewportLabel":"desktop","diff":{"misMatchPercentage":"0.00"}},"status":"pass"}' +
  ']});';

function writeFixture(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-res-'));
  const reportDir = path.join(dir, 'projects', 'x', 'backstop_data', 'html_report');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'config.js'), content);
  return dir;
}

test('getLastResult: parse del report', () => {
  const dir = writeFixture(FIXTURE);
  const res = getLastResult(dir, 'x');
  assert.deepStrictEqual(res.summary, { passed: 1, failed: 1, total: 2 });
  assert.strictEqual(res.tests.length, 2);
  assert.deepStrictEqual(res.tests[0], {
    label: 'Home',
    viewport: 'mobile',
    status: 'fail',
    misMatchPercentage: '7.81',
  });
  assert.ok(typeof res.at === 'string' && !Number.isNaN(Date.parse(res.at)));
});

test('getLastResult: file mancante → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-res-'));
  assert.strictEqual(getLastResult(dir, 'x'), null);
});

test('getLastResult: file corrotto → null', () => {
  const dir = writeFixture('report({broken');
  assert.strictEqual(getLastResult(dir, 'x'), null);
});
