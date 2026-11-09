import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithRules, extractOrderNumber, detectLanguage, detectSignals } from '../src/rules.js';
import { samples } from './helpers.js';

const r = (text, subject = '') => analyzeWithRules({ subject, text });

test('routes every sample support email to the expected intent', () => {
  const expected = {
    'emma.wilson': ['order_tracking'],
    'liam.chen': ['refund', 'return_request'],
    'sofia.garcia': ['order_tracking'],
    'noah.brown': ['refund'],
    'olivia.martin': ['refund', 'cancel_order'],
    'james.taylor': ['refund', 'damaged_item'],
    'amira.haddad': ['order_tracking', 'missing_package'],
    'mia.johnson': ['account_issue', 'password_reset'],
    'ethan.moore': ['account_issue', 'hacked'],
    'hannah.lee': ['order_tracking'],
    'lucas.dubois': ['refund'],
    'klaus.becker': ['account_issue', 'delete_account'],
    hello: ['other'],
  };
  for (const e of samples()) {
    const key = Object.keys(expected).find((k) => e.from.includes(`${k}@`));
    if (!key) continue;
    const out = r(e.body, e.subject);
    assert.equal(out.intent, expected[key][0], `${key}: ${out.intent}`);
    if (expected[key][1]) assert.equal(out.sub_type, expected[key][1], `${key} sub_type`);
  }
});

test('extracts order numbers in several formats and languages', () => {
  assert.equal(extractOrderNumber('my order #1001 is late'), '1001');
  assert.equal(extractOrderNumber('Order number: SH-20931'), 'SH-20931');
  assert.equal(extractOrderNumber('mi pedido 1003 no llegó'), '1003');
  assert.equal(extractOrderNumber('طلبي رقم 1007'), '1007');
  assert.equal(extractOrderNumber('call me at 555 1234'), null);
  assert.equal(extractOrderNumber('ref NW-99881 please', 'NW-\\d+'), 'NW-99881');
});

test('detects language', () => {
  assert.equal(detectLanguage('Hola, mi pedido no ha llegado, gracias'), 'es');
  assert.equal(detectLanguage('Bonjour, ma commande est en retard, merci'), 'fr');
  assert.equal(detectLanguage('Hallo, meine Bestellung ist nicht da, danke'), 'de');
  assert.equal(detectLanguage('مرحبا طلبي لم يصل'), 'ar');
  assert.equal(detectLanguage('Hi, where is my order?'), 'en');
});

test('hard signals and anger', () => {
  assert.deepEqual(detectSignals('I will contact my lawyer').includes('legal_threat'), true);
  assert.ok(detectSignals('I will file a chargeback').includes('chargeback'));
  assert.ok(detectSignals('my account was hacked').includes('security'));
  const angry = r('This is the THIRD time. UNACCEPTABLE!! I will call my bank and dispute the charge.');
  assert.ok(angry.anger >= 75, `anger ${angry.anger}`);
  assert.ok(angry.signals.includes('repeat_contact'));
  assert.equal(angry.needs_human, true);
  assert.ok(r('Thanks so much, where is my order #1?').anger < 30);
});
