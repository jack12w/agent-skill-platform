import { redirect } from 'next/navigation';

export default function WithdrawalsRedirect() {
  redirect('/hub/payment#withdrawals');
}
