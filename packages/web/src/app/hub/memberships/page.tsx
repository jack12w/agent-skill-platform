import { redirect } from 'next/navigation';

export default function MembershipsRedirect() {
  redirect('/hub/payment#memberships');
}
