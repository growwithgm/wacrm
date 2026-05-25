"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  MessageCircle,
  UserRound,
} from "lucide-react";

const features = [
  "Recover abandoned carts via WhatsApp",
  "Manage support from one shared inbox",
  "Launch broadcast campaigns",
  "Build visual automation flows",
];

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F9FB] p-4">
        <div className="w-full max-w-md rounded-3xl border border-[#E5E7EB] bg-white p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-[#16A34A]/10 text-[#16A34A]">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-black tracking-tight text-[#111827]">Check your email</h2>
          <p className="mt-3 text-sm leading-6 text-[#6B7280]">
            We&apos;ve sent a confirmation link to{" "}
            <span className="font-bold text-[#111827]">{email}</span>. Please check your inbox and click the link to verify your account.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-[#E5E7EB] text-sm font-bold text-[#111827] transition hover:bg-[#F7F9FB]"
          >
            <ArrowLeft className="h-4 w-4" /> Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F7F9FB] p-4 lg:p-8">
      <div className="grid min-h-[calc(100vh-2rem)] overflow-hidden rounded-[2rem] border border-[#E5E7EB] bg-white shadow-2xl shadow-[#0B1F16]/8 lg:grid-cols-[1fr_0.9fr]">

        {/* Left panel */}
        <div className="relative hidden bg-[#0B1F16] p-10 text-white lg:flex lg:flex-col">
          <div
            className="absolute inset-0 opacity-30"
            style={{
              background:
                "radial-gradient(circle at 25% 25%, #22C55E 0, transparent 28%), radial-gradient(circle at 80% 70%, #16A34A 0, transparent 30%)",
            }}
          />
          <div className="relative z-10 flex h-full flex-col">
            <Image src="/logo.png" alt="Wasify" height={36} width={160} className="object-contain" priority />
            <div className="my-auto max-w-xl">
              <span className="inline-flex items-center rounded-full bg-[#22C55E]/15 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-[#22C55E]">
                WhatsApp Business API SaaS
              </span>
              <h1 className="mt-6 text-5xl font-black leading-tight tracking-tight">
                Start building smarter customer journeys.
              </h1>
              <p className="mt-5 text-base leading-7 text-white/65">
                A premium CRM dashboard for shared inbox, contacts, sales pipelines, broadcasts, no-code automations and WhatsApp API settings.
              </p>
              <div className="mt-8 grid gap-3">
                {features.map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/6 p-3"
                  >
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-[#22C55E]" />
                    <span className="font-bold">{item}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-white/45">
              Modern, secure and business focused Wasify experience.
            </p>
          </div>
        </div>

        {/* Right panel — form */}
        <div className="flex items-center justify-center p-6 lg:p-10">
          <div className="w-full max-w-md">
            {/* Mobile logo */}
            <div className="mb-8 lg:hidden">
              <Image src="/logo.png" alt="Wasify" height={30} width={130} className="object-contain" />
            </div>

            <div className="mb-8">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#16A34A]/10 text-[#16A34A]">
                <MessageCircle className="h-6 w-6" />
              </div>
              <h2 className="text-3xl font-black tracking-tight text-[#111827]">
                Create your Wasify account
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#6B7280]">
                Start building smarter WhatsApp customer journeys.
              </p>
            </div>

            <form onSubmit={handleSignup} className="space-y-4">
              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {error}
                </div>
              )}

              {/* Full name */}
              <div>
                <label htmlFor="fullName" className="mb-2 block text-sm font-bold text-[#111827]">
                  Full name
                </label>
                <div className="flex h-12 items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white px-4 focus-within:border-[#16A34A] focus-within:ring-4 focus-within:ring-[#16A34A]/10">
                  <UserRound className="h-4 w-4 shrink-0 text-[#6B7280]" />
                  <input
                    id="fullName"
                    type="text"
                    placeholder="John Doe"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:text-[#9CA3AF]"
                  />
                </div>
              </div>

              {/* Email */}
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-bold text-[#111827]">
                  Email
                </label>
                <div className="flex h-12 items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white px-4 focus-within:border-[#16A34A] focus-within:ring-4 focus-within:ring-[#16A34A]/10">
                  <Mail className="h-4 w-4 shrink-0 text-[#6B7280]" />
                  <input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:text-[#9CA3AF]"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-bold text-[#111827]">
                  Password
                </label>
                <div className="flex h-12 items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white px-4 focus-within:border-[#16A34A] focus-within:ring-4 focus-within:ring-[#16A34A]/10">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-[#6B7280]" />
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:text-[#9CA3AF]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[#6B7280] hover:text-[#111827]"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div>
                <label htmlFor="confirmPassword" className="mb-2 block text-sm font-bold text-[#111827]">
                  Confirm password
                </label>
                <div className="flex h-12 items-center gap-3 rounded-2xl border border-[#E5E7EB] bg-white px-4 focus-within:border-[#16A34A] focus-within:ring-4 focus-within:ring-[#16A34A]/10">
                  <LockKeyhole className="h-4 w-4 shrink-0 text-[#6B7280]" />
                  <input
                    id="confirmPassword"
                    type={showConfirm ? "text" : "password"}
                    placeholder="Repeat your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:text-[#9CA3AF]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="text-[#6B7280] hover:text-[#111827]"
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#16A34A] px-4 text-sm font-extrabold text-white shadow-lg shadow-[#16A34A]/20 transition hover:bg-[#12843d] disabled:opacity-50"
              >
                {loading ? (
                  "Creating account..."
                ) : (
                  <>
                    Create account <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-[#6B7280]">
              Already have an account?{" "}
              <Link href="/login" className="font-extrabold text-[#16A34A] hover:text-[#12843d]">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
