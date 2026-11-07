/** The late fee for an invoice, given how many days past its due date today is. */
export function lateFee(daysPastDue, amount) {
  return daysPastDue > 0 ? amount * 0.05 : 0
}
