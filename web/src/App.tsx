/**
 * Root component: global toasts + the page routes for the whole web app.
 * Guests only ever see /j/:slug (join + call) and /r/:token (RSVP); hosts use the rest.
 */
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Spinner, Toaster } from "./components/ui";
import { useAuth } from "./lib/auth";
import { checkForNewBuild, isStale } from "./lib/freshness";
import Landing from "./pages/Landing";
import Admin from "./pages/Admin";
import Forgot from "./pages/Forgot";
import SignIn from "./pages/SignIn";
import { SignUp, SignUpDetails, SignUpVerify } from "./pages/SignUp";
import Home from "./pages/Home";
import Schedule from "./pages/Schedule";
import MeetingDetail from "./pages/MeetingDetail";
import SessionDetail from "./pages/SessionDetail";
import Past from "./pages/Past";
import Search from "./pages/Search";
import Team from "./pages/Team";
import { Billing, BillingDemo, BillingReturn } from "./pages/Billing";
import { CheckoutPage, ReceiptPage } from "./pages/Checkout";
import Settings from "./pages/Settings";
import Rsvp from "./pages/Rsvp";

// The call screen pulls in the media library, so it loads only when someone joins.
const Join = lazy(() => import("./pages/Join"));

/**
 * Guard for signed-in pages: shows a spinner while we check the session, and sends
 * signed-out visitors to /signin (remembering where they wanted to go via ?next=).
 */
function Private({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="flex h-full items-center justify-center text-brand-700"><Spinner size={28} /></div>;
  if (!me) return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

/** All page routes. Public: landing, sign-in, sign-up, join links (/j/...) and RSVP links (/r/...). Everything else needs an account. */
export default function App() {
  const loc = useLocation();
  // A newer Gather build is on the server: load it now, as the person moves to another page (never mid-call,
  // because a call doesn't change the page). Otherwise look again in the background.
  useEffect(() => { if (isStale()) window.location.reload(); else checkForNewBuild(); }, [loc.pathname]);
  // Toasts use dark styling on the call screen (/j/...), light everywhere else.
  return (
    <>
      <Toaster dark={loc.pathname.startsWith("/j/")} />
      <Suspense fallback={<div className="flex h-full items-center justify-center text-brand-700"><Spinner size={28} /></div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/signup/verify" element={<SignUpVerify />} />
          <Route path="/signup/details" element={<SignUpDetails />} />
          <Route path="/j/:slug" element={<Join />} />
          <Route path="/r/:token" element={<Rsvp />} />
          {/* Host/team pages share the sidebar layout and require sign-in */}
          <Route element={<Private><Layout /></Private>}>
            <Route path="/home" element={<Home />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/meetings/:id" element={<MeetingDetail />} />
            <Route path="/meetings/:id/edit" element={<Schedule />} />
            <Route path="/meetings/:id/sessions/:sid" element={<SessionDetail />} />
            <Route path="/past" element={<Past />} />
            <Route path="/search" element={<Search />} />
            <Route path="/team" element={<Team />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/billing/checkout" element={<CheckoutPage />} />
            <Route path="/billing/receipt/:reference" element={<ReceiptPage />} />
            <Route path="/billing/demo" element={<BillingDemo />} />
            <Route path="/billing/return" element={<BillingReturn />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
