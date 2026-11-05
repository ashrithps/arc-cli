// Ported near-verbatim from the arc app (budgetarc utils/debtMoney.ts, 1.0.49).
// A compatibility surface: keep it in step with the app, do not tidy it.
/**
 * A debt's money in two currencies (docs/specs/debt-cycle.md §2): the card's
 * own, which its statement, minimum, limit and instalment are in, and the
 * budget's, which every row Actual keeps is in (the "book"). A summary's
 * `fxRate` is card currency per budget unit: 1 for a card in the budget's
 * currency, null for a card in another one with no rate to be had.
 *
 * An INR card in a USD budget with no Card details saved read "Pay
 * $5,255.63": the rupee figure with the dollar sign, because the screen only
 * knew the card's currency from a tag. The currency comes from the account's
 * currency rule as well now (DebtCycleService cardCurrencyOf), and a figure
 * goes from one currency to the other only here.
 */

/** The rate when it can be used, else null. */
export function knownFx(fxRate: number | null | undefined): number | null {
  return fxRate != null && Number.isFinite(fxRate) && fxRate > 0 ? fxRate : null;
}

/** A card-currency amount (minor units) in the budget's currency (major units); null without a rate. */
export function cardToBook(cardMinor: number, fxRate: number | null | undefined): number | null {
  const fx = knownFx(fxRate);
  return fx == null ? null : cardMinor / 100 / fx;
}

/** A budget-currency amount (minor units) in the card's (minor units); null without a rate. */
export function bookToCard(bookMinor: number, fxRate: number | null | undefined): number | null {
  const fx = knownFx(fxRate);
  return fx == null ? null : Math.round(bookMinor * fx);
}

/**
 * What a payment into the debt prefills the transfer with: `send`, what leaves
 * the paying account, in the budget's currency (the transfer's own amount),
 * and for a card in another currency `receive`, the exact card-currency
 * figure, so the transfer lands the statement to the paisa rather than at
 * the send amount rounded to cents and converted back. Null when the figure
 * can't be put in the budget's currency (no rate).
 */
export interface DebtPayment {
  send: number;
  receive: number | null;
}

export function debtPaymentOf(
  cardMinor: number,
  fxRate: number | null | undefined,
  cardCurrency: string | null,
  budgetCurrency: string,
): DebtPayment | null {
  const send = cardToBook(cardMinor, fxRate);
  if (send == null || !(cardMinor > 0)) return null;
  const foreign = !!cardCurrency && cardCurrency.toUpperCase() !== budgetCurrency.toUpperCase();
  return { send: Math.round(send * 100) / 100, receive: foreign ? cardMinor / 100 : null };
}
