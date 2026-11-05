// Ported near-verbatim from the arc app (budgetarc utils/debtCharges.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Interest and fees as banks write them, so a debt's cost is found from the
 * row itself and not only from a category someone picked (docs/research/
 * debt-2026-11.md §2.3). Read on money off a debt account only: on a savings
 * account "interest" is money in, and German "Rente" is a pension.
 *
 * Latin scripts as words; Japanese and Chinese have no word breaks.
 */

export type DebtChargeKind = 'interest' | 'fee';

// Word edges that know accented letters: `\b` doesn't, so "Überziehungszinsen" had none.
const EDGE = '[A-Za-z0-9\u00C0-\u024F]';
const words = (alternatives: string[]) => new RegExp(`(?:^|(?!${EDGE}).)(?:${alternatives.join('|')})(?!${EDGE})`, 'i');

const INTEREST = words([
    // English (US, UK, IN, AU)
    'interest', 'int chg', 'int\\.? charge[sd]?', 'fin\\.? chg', 'finance charges?', 'purchase interest',
    'cash advance interest', 'interest charged?', 'emi interest',
    // German
    'sollzinsen', 'zinsen', 'überziehungszinsen', 'ueberziehungszinsen', 'kreditzinsen',
    // French
    'agios', 'int[ée]r[êe]ts?(?: d[ée]biteurs)?',
    // Spanish
    'intereses', 'inter[ée]s',
    // Italian
    'interessi',
    // Dutch
    'rente', 'debetrente',
    // Portuguese
    'juros(?: rotativos?)?', 'encargos',
]);

const FEE = words([
    // English
    'late (?:payment )?(?:fee|charges?)', 'annual fee', 'membership fee', 'renewal fee', 'over ?limit fee',
    'foreign (?:transaction|currency) fee', 'cash advance fee', 'returned payment fee', 'payment dishono(?:u)?r',
    '(?:i|c|s)?gst on', 'service tax on',
    // German
    'mahngeb[üu]hr', 'jahresentgelt', 'jahresgeb[üu]hr', 'auslandseinsatzentgelt',
    // French
    'frais de retard', 'cotisation(?: carte)?', 'frais de paiement',
    // Spanish
    'comisi[óo]n por demora', 'comisi[óo]n por reclamaci[óo]n', 'cuota anual',
    // Italian
    'commissione', 'canone annuo', 'penale',
    // Dutch
    'jaarlijkse bijdrage', 'jaarbijdrage', 'boete',
    // Portuguese
    'multa(?: por atraso)?', 'anuidade', 'iof',
]);

const INTEREST_CJK = /利息|利子|リボ払い手数料|循环利息|利息费/;
const FEE_CJK = /遅延損害金|年会費|滞纳金|违约金|年费|分期手续费|手续费|手数料/;

// A credit that takes interest or a fee back is no charge: these never count.
const TAKEN_BACK = words(['reversal', 'reversed', 'refund(?:ed)?', 'waiver', 'waived', 'credit adj', 'cashback', 'storno', 'r[üu]ckerstattung', 'remboursement', 'reembolso', 'estorno', 'rimborso', 'terugbetaling']);
const TAKEN_BACK_CJK = /返金|退款|冲正/;

// A purchase sold as costing nothing extra, whose words name interest.
const NO_INTEREST = words(['interest[- ]free', '0% interest', 'no[- ]cost emi', 'zinsfrei', 'sans frais', 'sin intereses', 'sem juros', 'senza interessi', 'renteloos']);
const NO_INTEREST_CJK = /無利息|免息/;

/** What a row on a debt account is, by its words: interest, a fee, or neither. */
export function debtChargeKind(text: string | null | undefined): DebtChargeKind | null {
  const t = (text ?? '').trim();
  if (!t || TAKEN_BACK.test(t) || TAKEN_BACK_CJK.test(t) || NO_INTEREST.test(t) || NO_INTEREST_CJK.test(t)) return null;
  if (INTEREST.test(t) || INTEREST_CJK.test(t)) return 'interest';
  if (FEE.test(t) || FEE_CJK.test(t)) return 'fee';
  return null;
}
