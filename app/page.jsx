import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import FinanzeApp from "@/components/FinanzeApp";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <FinanzeApp userEmail={user.email} />;
}
