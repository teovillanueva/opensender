import {
  BarChart3,
  Globe,
  KeyRound,
  Mail,
  Megaphone,
  Settings,
  Users,
  Webhook,
} from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  /** Router path (must match the corresponding file-based route). */
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * The dashboard's primary navigation (SPEC §13). Declared centrally so each
 * screen route file stays independent — adding a screen means adding its
 * route file plus one entry here, never editing the layout component.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: "/emails", label: "Emails", icon: Mail },
  { to: "/metrics", label: "Metrics", icon: BarChart3 },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/api-keys", label: "API Keys", icon: KeyRound },
  { to: "/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/audiences", label: "Audiences", icon: Users },
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { to: "/settings", label: "Settings", icon: Settings },
];
