import { redirect } from 'next/navigation';

export default function ReconciliationRedirect() {
  redirect('/hub/payment#reconciliation');
}
