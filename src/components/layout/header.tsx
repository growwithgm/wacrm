"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Bell, ChevronDown, LogOut, Menu, Search, Settings as SettingsIcon, User } from "lucide-react";
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

const pageTitles: Record<string, string> = {
  "/dashboard":  "Dashboard",
  "/inbox":      "Inbox",
  "/contacts":   "Contacts",
  "/pipelines":  "Pipelines",
  "/broadcasts": "Campaigns",
  "/automations":"Automations",
  "/flows":      "Flows",
  "/templates":  "Templates",
  "/shopify":    "Shopify",
  "/tags":       "Tags",
  "/settings":   "Settings",
};

function getPageTitle(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "Dashboard";
}

interface HeaderProps {
  onOpenSidebar?: () => void;
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const title = getPageTitle(pathname);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-white/90 px-4 py-4 backdrop-blur-xl lg:px-8">
      {/* Left — hamburger + title */}
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
            <span>Wasify</span>
            <span>/</span>
            <span className="text-primary">{title}</span>
          </div>
          <h1 className="truncate font-heading text-xl font-bold tracking-tight text-foreground lg:text-2xl">
            {title}
          </h1>
        </div>
      </div>

      {/* Center — search (desktop only) */}
      <div className="hidden h-11 flex-1 max-w-sm items-center gap-3 rounded-2xl border border-border bg-white px-4 shadow-sm md:flex">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Search contacts, messages, deals"
          aria-label="Search"
        />
      </div>

      {/* Right — bell + user */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Notifications"
          className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border bg-white text-foreground shadow-sm transition hover:bg-muted"
        >
          <Bell className="h-4 w-4" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-3 rounded-2xl border border-border bg-white px-3 py-2 shadow-sm transition hover:bg-muted focus:bg-muted focus:outline-none data-popup-open:bg-muted"
            aria-label="Open account menu"
          >
            <Avatar className="size-8">
              {profile?.avatar_url ? (
                <AvatarImage
                  src={profile.avatar_url}
                  alt={profile.full_name ?? "Avatar"}
                />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-sm font-black text-primary">
                {initial}
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-sm font-bold text-foreground sm:inline">
              {profile?.full_name ?? "User"}
            </span>
            <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:inline" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="min-w-56 bg-popover text-popover-foreground ring-border"
          >
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-bold text-foreground">
                {profile?.full_name ?? "User"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {profile?.email ?? ""}
              </p>
            </div>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              render={
                <Link
                  href="/settings?tab=profile"
                  className="text-foreground focus:bg-muted focus:text-foreground"
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
                  className="text-foreground focus:bg-muted focus:text-foreground"
                />
              }
            >
              <SettingsIcon className="size-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onClick={signOut}
              className="text-foreground focus:bg-muted focus:text-foreground"
            >
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
