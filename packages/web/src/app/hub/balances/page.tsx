import { redirect } from 'next/navigation';

export default function BalancesRedirect() {
  redirect('/hub/payment#balances');
}
