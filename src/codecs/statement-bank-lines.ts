// Ported near-verbatim from the arc app (budgetarc utils/statementBankLines.ts, 1.0.50).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * Lines the bank puts on an account itself (ux R24): interest, tax it
 * deducted or charged, and its own charges. The review shows them as one
 * line ("From DCB Bank: interest, tax · 3 lines") instead of a list nobody
 * needs to read. Matching is on the bank's text, in the 9 app languages.
 */

export type BankLineKind = 'interest' | 'tax' | 'charge';

const INTEREST = /\b(?:interest|int\.?\s?pd|int\.?\s?cr(?:edit)?|int\.?\s?coll|finance charges?|zinsen|habenzinsen|sollzinsen|int[ée]r[eê]ts?|intereses|interessi|rente|juros)\b|利息|利子/i;
// Tax the bank deducted or charged on its own charges; never a plain "tax"
// (a tax payment or refund is the user's own business).
const TAX = /\b(?:tds|tax deducted|withholding tax|gst|igst|cgst|sgst|vat|service tax|kapitalertragsteuer|abgeltungsteuer|solidarit[äa]tszuschlag|kest|retenue [àa] la source|retenci[oó]n|iva|ritenuta|imposta di bollo|bronbelasting|iof|irrf)\b|源泉|消費税|增值税|代扣/i;
const CHARGE = /\b(?:charges?|fees?|annual fee|late fee|penalty|sms alerts?|min(?:imum)?\.? bal(?:ance)?|non[- ]maintenance|geb[üu]hren?|entgelte?|kontof[üu]hrung|frais|cotisation|comisi[oó]n(?:es)?|cuota (?:anual|de mantenimiento)|commissioni|commissione|canone|kosten|provisie|tarifas?|anuidade)\b|geb[üu]hr|手数料|年会費|手续费|年费/i; // German builds compounds: "Kontoführungsgebühr"

// A payment the user made or got ("UPI/School fees", "NEFT/commission"): never the bank's own line.
const RAIL = /\b(?:upi|neft|imps|rtgs|pos|ecom|ach|nach|sepa|zelle|venmo|paypal|bpay|ideal|pix|paynow)\b/i;

/** What kind of bank line this is, or null for the user's own spending and income. */
export function bankLineKind(text: string | null | undefined): BankLineKind | null {
  if (!text || RAIL.test(text)) return null;
  if (TAX.test(text)) return 'tax';
  if (INTEREST.test(text)) return 'interest';
  if (CHARGE.test(text)) return 'charge';
  return null;
}

export interface BankLineGroup<T> {
  /** The bank's own lines, in their order. */
  lines: T[];
  /** Kinds present, in a fixed order (interest, tax, charge). */
  kinds: BankLineKind[];
  /** Their net, in the rows' own units (signed). */
  net: number;
}

/**
 * Split rows into the bank's own lines and the rest. Two or more bank lines
 * become a group; a single one stays where it is, as itself.
 */
export function groupBankLines<T>(rows: T[], textOf: (row: T) => string | null | undefined, amountOf: (row: T) => number): { group: BankLineGroup<T> | null; rest: T[] } {
  const kinds = new Set<BankLineKind>();
  const lines: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    const kind = bankLineKind(textOf(row));
    if (kind) {
      kinds.add(kind);
      lines.push(row);
    } else {
      rest.push(row);
    }
  }
  if (lines.length < 2) return { group: null, rest: rows };
  const order: BankLineKind[] = ['interest', 'tax', 'charge'];
  return {
    group: { lines, kinds: order.filter((k) => kinds.has(k)), net: lines.reduce((sum, r) => sum + amountOf(r), 0) },
    rest,
  };
}
