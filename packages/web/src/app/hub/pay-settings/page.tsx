import { redirect } from 'next/navigation';

export default function PaySettingsRedirect() {
  redirect('/hub/payment#pay-settings');
}
