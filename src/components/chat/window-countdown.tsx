"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { hoursUntilWindowCloses, isWithin24hWindow } from "@/lib/whatsapp-window";

export function WindowCountdown({ lastCustomerMessageAt }: { lastCustomerMessageAt: string | null }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (!lastCustomerMessageAt) return null;
  if (!isWithin24hWindow(lastCustomerMessageAt, now)) return null;

  const hoursRemaining = hoursUntilWindowCloses(lastCustomerMessageAt, now);
  const hours = Math.floor(hoursRemaining);
  const minutes = Math.round((hoursRemaining - hours) * 60);
  const isClosingSoon = hoursRemaining < 2;

  return (
    <div
      className={`flex items-center gap-1.5 text-xs ${isClosingSoon ? "text-warning" : "text-muted"}`}
      title="Tiempo restante de la ventana de 24h de WhatsApp"
    >
      <Clock size={12} />
      <span>
        Ventana 24h: quedan {hours}h {minutes}m
      </span>
    </div>
  );
}
