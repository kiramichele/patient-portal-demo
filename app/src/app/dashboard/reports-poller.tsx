"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ReportsPoller() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}