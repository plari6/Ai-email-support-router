/**
 * Keyword rules: a no-AI classifier with the same output shape as the AI one.
 * Used when every model fails, and as the source of "hard" signals (legal threat,
 * chargeback, hacked account) that are merged into the AI result and always go to a human.
 * Covers English, Spanish, French, German and Arabic.
 */

export const INTENTS = ['refund', 'order_tracking', 'account_issue', 'other'];

export const SUB_TYPES = {
  refund: ['refund_request', 'return_request', 'damaged_item', 'wrong_item', 'cancel_order', 'double_charge'],
  order_tracking: ['where_is_my_order', 'delayed', 'missing_package', 'change_address'],
  account_issue: ['password_reset', 'locked_out', 'email_change', 'delete_account', 'two_factor', 'hacked', 'billing_update'],
  other: ['general', 'product_question', 'feedback', 'spam'],
};

export const SIGNALS = ['legal_threat', 'chargeback', 'security', 'angry', 'repeat_contact', 'urgent', 'cancel_subscription'];
export const HARD_SIGNALS = ['legal_threat', 'chargeback', 'security'];

const INTENT_PATTERNS = {
  refund: [
    [/\brefund(s|ed|ing)?\b|money back|reimburse|charge ?back/i, 3],
    [/\breturn(ing)? (it|this|the|my)|send (it|this) back|return label|\brma\b/i, 2],
    [/\b(damaged|broken|defective|faulty|cracked|doesn'?t work|stopped working)\b/i, 1.5],
    [/\bwrong (item|colou?r|product|order|size)\b|not what i ordered|too (small|big|large|tight)|doesn'?t fit/i, 1.5],
    [/\bcancel (my|the|this) order\b|cancel order/i, 2],
    [/charged (me )?twice|double[- ]charged|duplicate charge|charged two times/i, 2.5],
    [/reembolso|devolu(ci[oó]n|ver)|devolver el dinero/i, 3],
    [/rembours|retourner|remboursement/i, 3],
    [/r[üu]ckerstattung|erstatten|geld zur[üu]ck|zur[üu]cksenden|retoure/i, 3],
    [/استرداد|استرجاع|ارجاع|إرجاع|المبلغ/, 3],
  ],
  order_tracking: [
    [/where('?s| is) my (order|package|parcel|delivery|stuff)/i, 3],
    [/\b(track(ing)?|shipment|shipping status|delivery status|out for delivery)\b/i, 2],
    [/\b(hasn'?t|has not|didn'?t|did not|never|still not|not yet) (arrived|been delivered|received|shipped|come)\b/i, 2.5],
    [/\b(late|delayed|delay|taking (so|too) long|when will (it|my order) (arrive|ship|be delivered))\b/i, 2],
    [/\b(lost|missing) (package|parcel|order|delivery)\b|marked as delivered/i, 2.5],
    [/change (my |the )?(shipping |delivery )?address/i, 1.5],
    [/d[oó]nde est[aá] mi (pedido|paquete)|seguimiento|no ha llegado|env[ií]o/i, 3],
    [/o[uù] est ma commande|suivi|pas (encore )?re[çc]u|livraison/i, 3],
    [/wo ist meine (bestellung|lieferung|paket)|sendungsverfolgung|nicht angekommen|lieferung/i, 3],
    [/أين طلبي|تتبع|الشحن|لم يصل|التوصيل|الشحنة/, 3],
  ],
  account_issue: [
    [/\b(password|passcode)\b|reset (link|email)|forgot (my )?(password|login)/i, 3],
    [/\b(can'?t|cannot|unable to|not able to) (log ?in|sign ?in|access)|locked out|account (is )?(locked|blocked|suspended|disabled)/i, 3],
    [/\b(2fa|two[- ]factor|verification code|otp|authenticator)\b/i, 2.5],
    [/change (my )?(email|e-mail|username)|update (my )?(email|e-mail|account)/i, 2],
    [/delete (my )?account|close (my )?account|remove my (data|account)|gdpr/i, 2.5],
    [/konto l[öo]schen|l[öo]schen sie mein konto|dsgvo|supprimer mon compte|rgpd|eliminar mi cuenta|borrar mi cuenta|حذف حسابي/i, 3],
    [/\b(hacked|compromised|unauthori[sz]ed (login|access|purchase|charge)|someone (else )?(logged|accessed))\b/i, 3],
    [/update (my )?(card|payment method|billing)|billing (details|info)/i, 1.5],
    [/contrase[ñn]a|no puedo (entrar|iniciar sesi[oó]n)|mi cuenta/i, 3],
    [/mot de passe|impossible de (me )?connecter|mon compte/i, 3],
    [/passwort|kann mich nicht anmelden|mein konto|konto gesperrt/i, 3],
    [/كلمة المرور|كلمة السر|تسجيل الدخول|حسابي|الحساب/, 3],
  ],
};

const SUB_PATTERNS = [
  ['refund', 'double_charge', /charged (me )?twice|double[- ]charged|duplicate charge|charged two times/i],
  ['refund', 'cancel_order', /cancel (my |the |this )?order/i],
  ['refund', 'damaged_item', /\b(damaged|broken|defective|faulty|cracked|doesn'?t work|stopped working)\b/i],
  ['refund', 'wrong_item', /\b(sent|received|got) (me )?(the |a )?wrong (item|colou?r|product)\b|wrong (item|product) (was )?(sent|delivered)|not what i ordered/i],
  ['refund', 'return_request', /\breturn\b|send (it|this) back|devolver|retourner|zur[üu]cksenden/i],
  ['order_tracking', 'missing_package', /\b(lost|missing)\b|marked as delivered|says (it was )?delivered|never (arrived|received)|didn'?t (get|receive) (it|anything)|no (lo )?he recibido|pas re[çc]u|nicht (erhalten|bekommen)|لم (أستلم|استلم)|لم يصل الطرد/i],
  ['order_tracking', 'change_address', /change (my |the )?(shipping |delivery )?address/i],
  ['order_tracking', 'delayed', /\b(late|delayed|delay|taking (so|too) long|still not)\b/i],
  ['account_issue', 'hacked', /\b(hacked|compromised|unauthori[sz]ed|someone (else )?(logged|accessed))\b/i],
  ['account_issue', 'delete_account', /delete (my )?account|close (my )?account|remove my (data|account)|gdpr|konto l[öo]schen|l[öo]schen sie mein konto|dsgvo|supprimer mon compte|rgpd|eliminar mi cuenta|borrar mi cuenta|حذف حسابي/i],
  ['account_issue', 'two_factor', /\b(2fa|two[- ]factor|verification code|otp|authenticator)\b/i],
  ['account_issue', 'email_change', /change (my )?(email|e-mail|username)/i],
  ['account_issue', 'billing_update', /update (my )?(card|payment method|billing)/i],
  ['account_issue', 'password_reset', /forgot (my )?password|reset (my )?password|reset (link|email)|olvid[eé] mi contrase|mot de passe oubli|passwort vergessen|نسيت كلمة/i],
  ['account_issue', 'locked_out', /locked out|account (is )?(locked|blocked|suspended|disabled)|can'?t (log ?in|sign ?in)/i],
  ['account_issue', 'password_reset', /password|contrase|mot de passe|passwort|كلمة/i],
];

const SIGNAL_PATTERNS = {
  legal_threat: /\b(lawyer|attorney|legal action|sue|suing|lawsuit|small claims|court|trading standards|consumer protection|ftc|bbb)\b|abogado|avocat|anwalt|محامي/i,
  chargeback: /charge ?back|dispute (the|this) (charge|payment)|call my bank|contact(ing)? my bank|report (you )?to (my bank|paypal|visa)|reverse the (charge|payment)/i,
  security: /\b(hacked|compromised|fraud(ulent)?|unauthori[sz]ed|identity theft|phishing|someone (else )?(logged|accessed|used))\b/i,
  repeat_contact: /\b(third|3rd|fourth|4th|fifth|several|multiple|many) (time|email|message)s?\b|\b(again|still) (no|waiting|nothing)\b|no (one|body) (has )?(replied|answered|responded)|(emailed|written|contacted) (you )?(\d+|several|multiple) times/i,
  urgent: /\b(urgent|asap|immediately|right now|today|emergency|deadline)\b|urgente|dringend|عاجل/i,
  cancel_subscription: /cancel (my )?(subscription|membership|plan)|unsubscribe me|close my account/i,
};

const ANGER_WORDS = /\b(ridiculous|unacceptable|disgusting|terrible|horrible|awful|worst|scam|joke|furious|angry|pathetic|useless|incompetent|outrageous|fed up|sick of|never again|wtf|shame)\b|inaceptable|inadmissible|unversch[äa]mt|سيء|احتيال/gi;
const POSITIVE = /\b(thank(s| you)|appreciate|great|love|awesome|perfect|happy|wonderful)\b/gi;

export function detectLanguage(text) {
  const s = String(text || '').toLowerCase();
  if (/[؀-ۿ]/.test(s)) return 'ar';
  const score = (words) => words.reduce((n, w) => n + (new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(s) ? 1 : 0), 0);
  const langs = {
    es: score(['el', 'la', 'que', 'mi', 'pedido', 'hola', 'gracias', 'por', 'no', 'es', 'una', 'para']),
    fr: score(['le', 'la', 'je', 'mon', 'ma', 'commande', 'bonjour', 'merci', 'pas', 'est', 'une', 'pour']),
    de: score(['der', 'die', 'das', 'ich', 'mein', 'meine', 'bestellung', 'hallo', 'danke', 'nicht', 'ist', 'und']),
    en: score(['the', 'my', 'i', 'is', 'order', 'hi', 'hello', 'thanks', 'not', 'and', 'for', 'you']),
  };
  const best = Object.entries(langs).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 2 ? best[0] : 'en';
}

/** Order numbers like "#1042", "order 1042", "order no. SH-20931", "pedido 1042". */
export function extractOrderNumber(text, pattern) {
  const s = String(text || '');
  if (pattern) {
    const m = s.match(new RegExp(pattern, 'i'));
    if (m) return (m[1] || m[0]).replace(/^#/, '').toUpperCase();
  }
  const ctx = s.match(/(?:order|commande|pedido|bestellung|ordine|طلبي?|الطلب)\s*(?:no\.?|number|num(?:ber|éro|ero)?|nr\.?|id|#|nº|n°|رقم)?\s*[:#]?\s*#?([A-Z]{0,4}-?\d{3,12})\b/i);
  if (ctx) return ctx[1].toUpperCase();
  const hash = s.match(/#\s?([A-Z]{0,4}-?\d{3,12})\b/i);
  return hash ? hash[1].toUpperCase() : null;
}

export function detectSignals(text) {
  return Object.entries(SIGNAL_PATTERNS)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
}

export function analyzeWithRules({ subject = '', text = '' } = {}, { orderPattern } = {}) {
  const s = `${subject}\n${text}`;
  const scores = Object.fromEntries(INTENTS.map((i) => [i, 0]));
  for (const [intent, pats] of Object.entries(INTENT_PATTERNS)) {
    for (const [re, w] of pats) if (re.test(s)) scores[intent] += w;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const second = ranked[1][1];
  const intent = topScore >= 1.5 ? top : 'other';
  const confidence = intent === 'other' ? 0.4 : Math.min(0.9, 0.45 + 0.1 * topScore - 0.08 * second);
  const sub = SUB_PATTERNS.find(([i, , re]) => i === intent && re.test(s));

  const signals = detectSignals(s);
  const angerHits = (s.match(ANGER_WORDS) || []).length;
  const caps = (s.match(/\b[A-Z]{4,}\b/g) || []).length;
  const bangs = (s.match(/!{2,}/g) || []).length;
  let anger = Math.min(100, 10 + angerHits * 18 + caps * 6 + bangs * 8 + (signals.includes('legal_threat') ? 35 : 0) + (signals.includes('chargeback') ? 25 : 0) + (signals.includes('repeat_contact') ? 15 : 0));
  const positive = (s.match(POSITIVE) || []).length;
  if (positive && anger < 30) anger = Math.max(0, anger - 10);
  if (anger >= 60 && !signals.includes('angry')) signals.push('angry');
  const sentiment = anger >= 60 ? 'negative' : anger >= 35 ? 'frustrated' : positive ? 'positive' : 'neutral';
  const urgency = Math.min(100, 20 + (signals.includes('urgent') ? 30 : 0) + (signals.includes('repeat_contact') ? 20 : 0) + Math.round(anger / 3));

  return {
    intent,
    sub_type: sub ? sub[1] : intent === 'other' ? 'general' : SUB_TYPES[intent][0],
    confidence: Math.round(confidence * 100) / 100,
    order_number: extractOrderNumber(s, orderPattern),
    language: detectLanguage(s),
    sentiment,
    anger,
    urgency,
    signals,
    summary: summarize(intent, sub?.[1]),
    needs_human: signals.some((x) => HARD_SIGNALS.includes(x)),
    reason: intent === 'other' ? 'no strong support keywords' : `keywords matched for ${intent} (score ${topScore})`,
    source: 'rules',
  };
}

function summarize(intent, sub) {
  const labels = {
    refund: 'Customer asks for a refund or return',
    order_tracking: 'Customer asks where their order is',
    account_issue: 'Customer has a problem with their account',
    other: 'General enquiry',
  };
  return sub ? `${labels[intent]} (${sub.replace(/_/g, ' ')})` : labels[intent];
}
