"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useWhatsAppConnection, WA_STATE_UI } from "@/hooks/use-whatsapp-connection";
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  GitBranch,
  Radio,
  Zap,
  Workflow,
  Settings,
  LogOut,
  User,
  X,
  ShieldCheck,
  ChevronDown,
  FileText,
  ShoppingCart,
  ShoppingBag,
  Store,
  Tag,
  BadgeCheck,
  RotateCcw,
  Percent,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  beta?: boolean;
}

// Labels follow the approved "Wasify 2" design (Dashboard→Overview,
// Broadcasts→Campaigns). Every existing route is kept so no feature is
// orphaned — Pipelines and Tags sit alongside the design's nav.
const navItems: NavItem[] = [
  { href: "/dashboard",       label: "Overview",        icon: LayoutDashboard },
  { href: "/inbox",           label: "Inbox",           icon: MessageSquare },
  { href: "/broadcasts",      label: "Campaigns",       icon: Radio },
  { href: "/contacts",        label: "Contacts",        icon: Users },
  { href: "/orders",          label: "Orders",          icon: ShoppingBag },
  { href: "/abandoned-carts", label: "Abandoned Carts", icon: ShoppingCart },
  { href: "/recovery",        label: "Cart Recovery",   icon: RotateCcw },
  { href: "/cod",             label: "COD Confirmation", icon: BadgeCheck },
  { href: "/discounts",       label: "Discounts",       icon: Percent },
  { href: "/pipelines",       label: "Pipelines",       icon: GitBranch },
  { href: "/automations",     label: "Automations",     icon: Zap },
  { href: "/flows",           label: "Flows",           icon: Workflow, beta: true },
  { href: "/shopify",         label: "Shopify",         icon: Store },
  { href: "/templates",       label: "Templates",       icon: FileText },
  { href: "/tags",            label: "Tags",            icon: Tag },
  { href: "/settings",        label: "Settings",        icon: Settings },
];

// Wasify brand mark — green outlined speech bubble with a bold "W" and the
// automation-node accent, recreated as crisp SVG (per the "Wasify 2" design)
// so it stays sharp at any size on the dark-green sidebar.
function WasifyMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M28 6 H8 A4 4 0 0 0 4 10 V22 A4 4 0 0 0 8 26 H11 V31 L17 26 H28 A4 4 0 0 0 32 22 V10 A4 4 0 0 0 28 6 Z"
        stroke="#22C55E"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M11 12 L14 21 L18 15 L22 21 L25 12"
        stroke="#22C55E"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="25.5"
        y1="11"
        x2="28"
        y2="8.6"
        stroke="#22C55E"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="25.5" cy="11" r="1.1" fill="#22C55E" />
      <circle cx="28" cy="8.6" r="1.4" fill="#22C55E" />
    </svg>
  );
}

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const wa = useWhatsAppConnection();

  useEffect(() => {
    onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-72 flex-col bg-sidebar px-4 py-5 text-sidebar-foreground",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // 240px fixed rail on desktop, per the Wasify 2 spec.
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none",
        )}
        aria-label="Primary"
      >
        {/* Logo row — green mark + wordmark */}
        <div className="flex items-center justify-between px-1.5">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <WasifyMark className="h-[34px] w-[34px] shrink-0" />
            <span className="font-heading text-xl font-extrabold tracking-tight text-white">
              Wasify
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-white/50 hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="mt-7 flex-1 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));

            const showUnreadBadge =
              item.href === "/inbox" && totalUnread > 0;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 font-heading text-sm font-bold transition",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-[0_6px_16px_rgba(22,163,74,0.32)]"
                    : "text-sidebar-foreground/60 hover:bg-white/[0.06] hover:text-sidebar-foreground",
                )}
              >
                <item.icon className="h-[18px] w-[18px] shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
                {item.beta && (
                  <span className="rounded-full bg-primary-soft-2 px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-wide text-sidebar-primary">
                    Beta
                  </span>
                )}
                {showUnreadBadge && (
                  <span
                    className={cn(
                      "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-extrabold",
                      isActive
                        ? "bg-white/25 text-white"
                        : "bg-sidebar-primary text-sidebar",
                    )}
                  >
                    {totalUnread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* API status card — honest 3-state WhatsApp connection (shared source) */}
        <Link
          href="/settings?tab=whatsapp"
          className="mt-3 block rounded-2xl border border-white/10 bg-white/[0.04] p-3.5 transition hover:bg-white/[0.07]"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-soft-2 text-sidebar-primary">
              <ShieldCheck className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0">
              <p className="font-heading text-[13px] font-extrabold text-white">
                API status
              </p>
              <p className="flex items-center gap-1.5 text-[11.5px] text-white/60">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    WA_STATE_UI[wa.state].dot,
                  )}
                />
                <span className="truncate">{WA_STATE_UI[wa.state].label}</span>
              </p>
            </div>
          </div>
        </Link>

        {/* User section */}
        <div className="mt-2.5 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none data-popup-open:bg-white/[0.06]">
              <Avatar className="size-9 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? "Avatar"}
                  />
                ) : null}
                <AvatarFallback className="bg-sidebar-primary/20 font-heading text-sm font-extrabold text-sidebar-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading text-[13.5px] font-extrabold text-white">
                  {profile?.full_name ?? "User"}
                </p>
                <p className="truncate text-[11.5px] text-white/50">
                  {profile?.email ?? ""}
                </p>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-white/40" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-sidebar-surface-2 text-sidebar-foreground ring-sidebar-border"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-sidebar-foreground/80 focus:bg-sidebar-foreground/10 focus:text-sidebar-foreground"
                  />
                }
              >
                <User className="size-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-sidebar-foreground/80 focus:bg-sidebar-foreground/10 focus:text-sidebar-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-white/10" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-white/80 focus:bg-white/10 focus:text-white"
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
